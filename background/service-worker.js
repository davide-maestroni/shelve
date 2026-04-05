/**
 * Shelve — Background Service Worker
 * Orchestrates archiving, storage, and classification.
 */

import { normalizeUrl, generateId } from '../lib/utils.js';
import { Summarizer } from '../lib/summarizer.js';
import { Classifier } from '../lib/classifier.js';
import * as Store from '../lib/storage.js';

// ─── Icon ─────────────────────────────────────────────────────────────────────

/**
 * Draw the Shelve bookshelf icon onto an OffscreenCanvas and set it as the
 * action icon. Chrome does not support SVG for extension icons, so we draw
 * the icon programmatically here.
 */
function setActionIcon() {
  const sizes = [16, 32, 48, 128];
  const imageData = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const s = size / 128;

    const rr = (x, y, w, h, radius, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x * s, y * s, w * s, h * s, radius * s);
      ctx.fill();
    };

    // Background
    rr(0, 0, 128, 128, 24, '#4f46e5');
    // Side panels
    rr(14, 14, 8, 104, 3, '#a5b4fc');
    rr(106, 14, 8, 104, 3, '#a5b4fc');
    // Books row 1
    rr(26, 18, 14, 26, 2, '#f59e0b');
    rr(44, 22, 10, 22, 2, '#10b981');
    rr(58, 16, 16, 28, 2, '#ef4444');
    rr(78, 20, 12, 24, 2, '#8b5cf6');
    rr(94, 18, 10, 26, 2, '#3b82f6');
    // Shelf board 1
    rr(16, 44, 96, 10, 3, '#c7d2fe');
    // Books row 2
    rr(26, 54, 12, 24, 2, '#06b6d4');
    rr(42, 50, 16, 28, 2, '#f97316');
    rr(62, 54, 10, 24, 2, '#84cc16');
    rr(76, 52, 14, 26, 2, '#ec4899');
    rr(94, 56, 10, 22, 2, '#a5b4fc');
    // Shelf board 2
    rr(16, 78, 96, 10, 3, '#c7d2fe');
    // Bottom shelf
    rr(16, 112, 96, 6, 3, '#c7d2fe');

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }

  chrome.action.setIcon({ imageData }).catch(console.warn);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  setActionIcon();
  await Store.bootstrapFromSync();
  broadcast({ type: 'ready' });
  _maybeAutoFetch();
});

chrome.runtime.onStartup.addListener(async () => {
  setActionIcon();
  await Store.bootstrapFromSync().catch(console.warn);
  _maybeAutoFetch();
});

async function _maybeAutoFetch() {
  const settings = await Store.getSettings();
  if (!settings.autoFetchMissing) return;
  // Small delay so the browser has settled before we start opening tabs
  setTimeout(() => {
    fetchMissingData().catch(e => console.warn('[Shelve] auto-fetch failed:', e));
  }, 5000);
}

// Listen for storage changes from other devices (sync)
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  // Re-merge any new tab metadata from sync
  const tabChanges = Object.entries(changes)
    .filter(([k]) => k.startsWith('shelve_tabmeta_'))
    .map(([, { newValue }]) => newValue)
    .filter(Boolean);

  if (tabChanges.length) {
    const tabs = await Store.getTabs();
    let dirty = false;
    for (const meta of tabChanges) {
      if (!tabs[meta.normalizedUrl]) {
        tabs[meta.normalizedUrl] = { ...meta, content: '', _syncOnly: true };
        dirty = true;
      }
    }
    if (dirty) {
      await chrome.storage.local.set({ shelve_tabs: tabs });
      broadcast({ type: 'tabs_updated' });
    }
  }
});

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    console.error('[Shelve SW]', err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'archive_current': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');
      await archiveTab(tab);
      return { ok: true };
    }
    case 'archive_all': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const validTabs = tabs.filter(isArchivable);
      await archiveTabs(validTabs);
      return { ok: true, count: validTabs.length };
    }
    case 'archive_close_current': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');
      await archiveTab(tab);
      await chrome.tabs.remove(tab.id);
      return { ok: true };
    }
    case 'archive_close_all': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const validTabs = tabs.filter(isArchivable);
      await archiveTabs(validTabs);
      const ids = validTabs.map(t => t.id);
      if (ids.length) {
        // Ensure the Shelve archive page stays open so the window isn't left empty
        await openArchivePage();
        await chrome.tabs.remove(ids);
      }
      return { ok: true, count: validTabs.length };
    }
    case 'rearchive': {
      await reArchiveUrl(msg.url);
      return { ok: true };
    }
    case 'delete_tab': {
      const deletedTab = (await Store.getTabs())[normalizeUrl(msg.normalizedUrl)];
      await Store.removeTab(normalizeUrl(msg.normalizedUrl));
      await _refreshFitScores();
      broadcast({ type: 'tabs_updated' });
      if (deletedTab?.shelfId) _recomputeShelfColor(deletedTab.shelfId).catch(() => {});
      return { ok: true };
    }
    case 'update_tab': {
      await Store.setTab(msg.normalizedUrl, msg.data);
      broadcast({ type: 'tabs_updated' });
      return { ok: true };
    }
    case 'create_shelf': {
      const id = generateId();
      const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];
      const existingShelves = await Store.getShelves();
      const color = COLORS[Object.keys(existingShelves).length % COLORS.length];
      await Store.setShelf(id, {
        id, title: msg.title, customTitle: null,
        color, order: 0, isUnsorted: false,
      });
      broadcast({ type: 'shelves_updated' });
      return { ok: true, id };
    }
    case 'update_shelf': {
      await Store.setShelf(msg.id, msg.data);
      broadcast({ type: 'shelves_updated' });
      return { ok: true };
    }
    case 'set_tab_order': {
      await Store.setTabOrder(msg.shelfId, msg.order);
      return { ok: true };
    }
    case 'get_tabs': {
      return Store.getTabs();
    }
    case 'get_shelves': {
      return Store.getShelves();
    }
    case 'get_settings': {
      return Store.getSettings();
    }
    case 'set_settings': {
      await Store.setSettings(msg.settings);
      broadcast({ type: 'settings_updated', settings: msg.settings });
      return { ok: true };
    }
    case 'open_archive': {
      await openArchivePage();
      return { ok: true };
    }
    case 'move_tab_to_shelf': {
      const { normalizedUrl, targetShelfId, sourceShelfId } = msg;
      await Store.setTab(normalizedUrl, {
        shelfId: targetShelfId,
        fitScore: null,
        suggestedShelfId: null,
      });
      await _refreshFitScores([targetShelfId, sourceShelfId].filter(Boolean));
      broadcast({ type: 'tabs_updated' });
      (async () => {
        for (const id of [targetShelfId, sourceShelfId].filter(Boolean))
          await _recomputeShelfColor(id).catch(() => {});
      })();
      return { ok: true };
    }
    case 'delete_all': {
      // Clear data keys from local (preserve nothing — thumbnails, tabs, shelves, orders)
      await chrome.storage.local.remove([
        'shelve_tabs', 'shelve_thumbnails', 'shelve_collections',
        'shelve_tab_orders', 'shelve_col_order',
      ]);
      // Clear data keys from sync: static keys + all per-tab metadata keys
      const syncData = await chrome.storage.sync.get(null);
      const syncDataKeys = Object.keys(syncData).filter(k =>
        k === 'shelve_tabs' || k === 'shelve_collections' ||
        k === 'shelve_tab_orders' || k.startsWith('shelve_tabmeta_')
      );
      if (syncDataKeys.length) await chrome.storage.sync.remove(syncDataKeys);
      broadcast({ type: 'tabs_updated' });
      broadcast({ type: 'shelves_updated' });
      return { ok: true };
    }
    case 'delete_shelf_tabs': {
      const tabsMap     = await Store.getTabs();
      const toDelete    = Object.values(tabsMap).filter(t => t.shelfId === msg.shelfId);
      await Promise.all(toDelete.map(t => Store.removeTab(t.normalizedUrl)));
      await _refreshFitScores();
      broadcast({ type: 'tabs_updated' });
      _recomputeShelfColor(msg.shelfId).catch(() => {});
      return { ok: true };
    }
    case 'delete_shelf': {
      const tabsMap = await Store.getTabs();
      const toDelete = Object.values(tabsMap).filter(t => t.shelfId === msg.id);
      // Remove tabs and their thumbnails in parallel
      await Promise.all(toDelete.map(t => Store.removeTab(t.normalizedUrl)));
      await Store.removeShelf(msg.id);
      await _refreshFitScores();
      broadcast({ type: 'tabs_updated' });
      broadcast({ type: 'shelves_updated' });
      return { ok: true };
    }
    case 'fetch_missing': {
      // Fire-and-forget: respond immediately, process runs in background
      fetchMissingData().catch(e => broadcast({ type: 'fetch_missing_error', message: e.message }));
      return { ok: true };
    }
    case 'cancel_fetch_missing': {
      _fetchCancelled = true;
      return { ok: true };
    }
    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ─── Core archiving logic ─────────────────────────────────────────────────────

function isArchivable(tab) {
  return tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('about:');
}

/**
 * If a tab has been discarded by Chrome (renderer killed to save memory),
 * reloads it and waits for it to finish loading before returning.
 */
async function ensureTabReady(tab) {
  if (!tab.discarded) return;
  await new Promise(resolve => {
    chrome.tabs.reload(tab.id);
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(); // timeout — continue anyway rather than crashing the loop
    }, 15000);
    function onUpdated(id, info) {
      if (id !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeout);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  await sleep(200);
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {{ skipClassification?: boolean, forceCapture?: boolean }} opts
 *   skipClassification – skip collection assignment and fit-score refresh (use in batch mode).
 *   forceCapture – skip the freshTab.active check and always attempt thumbnail capture.
 */
async function archiveTab(tab, { skipClassification = false, forceCapture = false } = {}) {
  if (!isArchivable(tab)) return;

  const nUrl = normalizeUrl(tab.url);
  broadcast({ type: 'archive_start', url: nUrl, title: tab.title });

  try {
    // 1. Capture thumbnail first — must happen while the tab is still active,
    //    before content extraction consumes time and risks losing focus.
    let thumbnail = null;
    try {
      const freshTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (forceCapture || freshTab?.active) {
        const capture = () => Promise.race([
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Capture timeout')), 3000)),
        ]);
        let raw = await capture();
        // Retry up to 5 times if the frame looks blank (unrendered tab).
        for (let i = 0; i < 5 && !await _isMeaningfulCapture(raw); i++) {
          await sleep(300);
          raw = await capture().catch(() => null);
        }
        if (raw) {
          thumbnail = await resizeThumbnail(raw, 480, 270);
        }
      }
    } catch (e) {
      console.warn('[Shelve] Thumbnail capture failed:', e.message);
    }

    // 2. Extract page content via content script (works on any tab, no focus needed)
    let extracted = { title: tab.title, content: '', metaDescription: '', url: tab.url };
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content-script.js'],
      });
      if (result?.result?.success) extracted = result.result;
    } catch (e) {
      console.warn('[Shelve] Content extraction failed for', tab.url, e.message);
    }

    // 3. Generate description
    const existing = await Store.getTab(nUrl);
    const textForSummary = extracted.content || extracted.metaDescription || '';
    const description = textForSummary.length > 50
      ? Summarizer.summarize(textForSummary, 3)
      : (extracted.metaDescription || truncateTitle(extracted.title, 200));

    // 4. Save to storage
    const now = Date.now();
    await Store.setTab(nUrl, {
      url: tab.url,
      normalizedUrl: nUrl,
      favIconUrl: tab.favIconUrl || '',
      title: extracted.title || tab.title || nUrl,
      customTitle: existing?.customTitle ?? null,
      description,
      customDescription: existing?.customDescription ?? null,
      content: extracted.content,
      firstArchived: existing?.firstArchived ?? now,
      lastArchived: now,
      shelfId: existing?.shelfId ?? null,
    });

    if (thumbnail) await Store.setThumbnail(nUrl, thumbnail);

    // 5. Assign to a shelf by favicon domain; run fit scores for move suggestions
    if (!skipClassification) {
      if (!existing?.shelfId) {
        await _assignByFavicon(nUrl);
      } else {
        await _refreshFitScores();
      }
      const savedTab = (await Store.getTabs())[nUrl];
      if (savedTab?.shelfId) _recomputeShelfColor(savedTab.shelfId).catch(() => {});
    }

    broadcast({ type: 'archive_done', url: nUrl });

  } catch (e) {
    broadcast({ type: 'archive_error', url: nUrl, message: e.message });
    console.error('[Shelve] archiveTab error:', e);
  }
}

/**
 * Activates a tab, waits for the onActivated event, waits for it to finish
 * loading if needed, then sleeps to let the compositor render a frame.
 */
async function _activateAndWait(tabId) {
  // Step 1: switch focus and wait for onActivated
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onActivated.removeListener(onActivated);
      resolve();
    }, 3000);
    function onActivated({ tabId: id }) {
      if (id !== tabId) return;
      chrome.tabs.onActivated.removeListener(onActivated);
      clearTimeout(timer);
      resolve();
    }
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.update(tabId, { active: true }).catch(() => {
      chrome.tabs.onActivated.removeListener(onActivated);
      clearTimeout(timer);
      resolve();
    });
  });

  // Step 2: ensure the window is focused at the OS level (required for captureVisibleTab)
  const freshTab = await chrome.tabs.get(tabId).catch(() => null);
  if (freshTab?.windowId) {
    await chrome.windows.update(freshTab.windowId, { focused: true }).catch(() => {});
  }

  // Step 3: if the tab is still loading, wait for it to finish
  if (freshTab && freshTab.status !== 'complete') {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, 5000);
      function onUpdated(id, info) {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  // Step 4: give the compositor time to render the first frame
  await sleep(300);
}

async function archiveTabs(tabs) {
  // Process the currently active tab first so it's captured before any focus switching
  tabs = [...tabs].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

  let done = 0;
  const total = tabs.length;
  broadcast({ type: 'archive_batch_start', total });

  const settings = await Store.getSettings();
  const switchFocus = !!settings.switchFocus;

  const [originalActive] = switchFocus
    ? await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null])
    : [null];

  for (const tab of tabs) {
    const isBackground = !tab.active;
    await ensureTabReady(tab);
    if (isBackground && switchFocus) {
      await _activateAndWait(tab.id);
    }
    await archiveTab(tab, { skipClassification: true });
    done++;
    broadcast({ type: 'archive_batch_progress', done, total });
  }

  if (switchFocus && originalActive) {
    await chrome.tabs.update(originalActive.id, { active: true }).catch(() => {});
  }

  // Run classification once for all tabs instead of once per tab
  await _reclassifyAll();

  // Recompute shelf colors from favicons sequentially to avoid storage write races
  const allShelves = await Store.getShelves();
  (async () => {
    for (const shelf of Object.values(allShelves)) {
      if (!shelf.isUnsorted) await _recomputeShelfColor(shelf.id).catch(() => {});
    }
  })();

  broadcast({ type: 'archive_batch_done', total });
  showNotification(`Shelve: shelved ${total} tab${total !== 1 ? 's' : ''}`);
}

async function reArchiveUrl(url) {
  broadcast({ type: 'rearchive_start', url });
  const settings = await Store.getSettings();
  const switchFocus = !!settings.switchFocus;
  const [originalActive] = switchFocus
    ? await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null])
    : [null];
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, async (newTab) => {
      const tabLoadedHandler = async (tabId, info) => {
        if (tabId !== newTab.id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(tabLoadedHandler);
        try {
          const nUrl = normalizeUrl(url);
          const existing = await Store.getTab(nUrl);
          if (existing) {
            await Store.setTab(nUrl, { customTitle: null, customDescription: null });
          }
          let tabToArchive = newTab;
          if (switchFocus) {
            await _activateAndWait(newTab.id);
            tabToArchive = await chrome.tabs.get(newTab.id).catch(() => newTab);
          }
          await archiveTab(tabToArchive, { forceCapture: switchFocus });
          await chrome.tabs.remove(newTab.id);
          if (originalActive) await chrome.tabs.update(originalActive.id, { active: true }).catch(() => {});
          broadcast({ type: 'rearchive_done', url });
          resolve();
        } catch (e) {
          chrome.tabs.remove(newTab.id).catch(() => {});
          if (originalActive) await chrome.tabs.update(originalActive.id, { active: true }).catch(() => {});
          reject(e);
        }
      };
      chrome.tabs.onUpdated.addListener(tabLoadedHandler);
    });
  });
}

// ─── Fetch missing data ───────────────────────────────────────────────────────

// Cancellation flag; set to true by 'cancel_fetch_missing' message
let _fetchCancelled = false;

/**
 * Finds all archived tabs that are missing a thumbnail or page text,
 * opens each URL in a temporary background tab, archives it (preserving
 * any custom title/description the user set), then closes it.
 *
 * Broadcasts fetch_missing_progress, fetch_missing_done, fetch_missing_cancelled.
 */
async function fetchMissingData() {
  _fetchCancelled = false;

  const [tabsMap, thumbnails, settings] = await Promise.all([
    Store.getTabs(),
    Store.getThumbnails(),
    Store.getSettings(),
  ]);
  const switchFocus = !!settings.switchFocus;

  // Identify tabs that need work
  const needsFetch = Object.values(tabsMap).filter(tab => {
    const missingContent   = !tab.content || tab.content.trim().length === 0;
    const missingThumb     = !thumbnails[tab.normalizedUrl];
    return missingContent || missingThumb;
  });

  const total   = needsFetch.length;
  let done      = 0;
  let skipped   = 0;   // tabs that were already complete at the time of check
  let fetched   = 0;

  if (total === 0) {
    broadcast({ type: 'fetch_missing_done', fetched: 0, skipped: Object.keys(tabsMap).length });
    return;
  }

  broadcast({ type: 'fetch_missing_progress', done: 0, total, current: '' });

  for (const tab of needsFetch) {
    if (_fetchCancelled) {
      broadcast({ type: 'fetch_missing_cancelled', done });
      return;
    }

    broadcast({ type: 'fetch_missing_progress', done, total, current: tab.customTitle || tab.title || tab.url });

    try {
      await _fetchTabData(tab, switchFocus);
      fetched++;
    } catch (e) {
      console.warn('[Shelve] fetchMissingData: failed for', tab.url, e.message);
      // Continue with the rest even if one tab fails
    }

    done++;
  }

  broadcast({ type: 'fetch_missing_done', fetched, skipped });
  broadcast({ type: 'tabs_updated' });
}

/**
 * Opens a single tab URL in a temporary background tab, runs the archiver,
 * then closes the tab. Preserves existing custom title/description.
 */
async function _fetchTabData(tabMeta, switchFocus = false) {
  const [originalActive] = switchFocus
    ? await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null])
    : [null];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.remove(newTabId).catch(() => {});
      reject(new Error(`Timeout loading ${tabMeta.url}`));
    }, 30_000);

    let newTabId = -1;

    chrome.tabs.create({ url: tabMeta.url, active: false }, async newTab => {
      newTabId = newTab.id;

      const onUpdated = async (tabId, info) => {
        if (tabId !== newTab.id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timeout);

        try {
          let tabToArchive = newTab;
          if (switchFocus) {
            await _activateAndWait(newTab.id);
            tabToArchive = await chrome.tabs.get(newTab.id).catch(() => newTab);
          }
          await archiveTab(tabToArchive, { forceCapture: switchFocus });
          await chrome.tabs.remove(newTab.id);
          if (originalActive) await chrome.tabs.update(originalActive.id, { active: true }).catch(() => {});
          resolve();
        } catch (e) {
          chrome.tabs.remove(newTab.id).catch(() => {});
          if (originalActive) await chrome.tabs.update(originalActive.id, { active: true }).catch(() => {});
          reject(e);
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

// ─── Classification ───────────────────────────────────────────────────────────

// ─── Favicon-based shelf assignment ───────────────────────────────────────────

/** Returns the base domain (e.g. "github.com") from a URL string. */
function _extractDomain(url) {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : parts[0];
  } catch {
    return '';
  }
}

/** Turns a domain into a human-readable shelf title (e.g. "github.com" → "Github"). */
function _domainToTitle(domain) {
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Deterministic color from domain so the same site always gets the same color. */
function _domainColor(domain) {
  const PALETTE = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316',
    '#f59e0b','#10b981','#06b6d4','#3b82f6','#84cc16'];
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Returns true if the hex color is achromatic (greyscale). */
function _isGreyscale(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

/**
 * Given a Map<hex, count>, returns the most frequent non-greyscale color,
 * falling back to the most frequent greyscale if none are chromatic.
 */
function _pickDominantColor(freqMap) {
  if (!freqMap.size) return null;
  const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
  const chromatic = sorted.find(([hex]) => !_isGreyscale(hex));
  return chromatic ? chromatic[0] : sorted[0][0];
}

/** Returns a Map<hex, count> of colors from an SVG string (excluding near-black/white). */
function _colorFreqFromSvg(svgText) {
  const freq = new Map();
  const hexRe = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m;
  while ((m = hexRe.exec(svgText)) !== null) {
    let hex = m[1].length === 3
      ? m[1].split('').map(c => c + c).join('')
      : m[1];
    hex = '#' + hex.toLowerCase();
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 20 || lum > 230) continue; // skip near-black and near-white
    freq.set(hex, (freq.get(hex) || 0) + 1);
  }
  return freq;
}

/** Returns a Map<hex, count> of quantized colors sampled from a raster image Blob. */
async function _colorFreqFromRaster(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const SIZE = 16;
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    const freq = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // skip transparent
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 20 || lum > 230) continue; // skip near-black and near-white
      // Quantize to reduce noise (clamp to 240 to avoid overflow past 0xff)
      const qr = Math.min(240, Math.round(r / 32) * 32);
      const qg = Math.min(240, Math.round(g / 32) * 32);
      const qb = Math.min(240, Math.round(b / 32) * 32);
      const hex = `#${qr.toString(16).padStart(2,'0')}${qg.toString(16).padStart(2,'0')}${qb.toString(16).padStart(2,'0')}`;
      freq.set(hex, (freq.get(hex) || 0) + 1);
    }
    return freq;
  } catch {
    return new Map();
  }
}

/** Fetches a favicon URL and returns a color frequency Map, or null on failure. */
async function _colorFreqFromFavicon(favIconUrl) {
  if (!favIconUrl) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(favIconUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('svg') || favIconUrl.toLowerCase().endsWith('.svg')) {
      return _colorFreqFromSvg(await resp.text());
    }
    return _colorFreqFromRaster(await resp.blob());
  } catch {
    return null;
  }
}

/**
 * Recomputes the default color of a shelf by merging color-frequency statistics
 * from all unique favicons, preferring the most frequent non-greyscale color and
 * falling back to the most frequent grey, then a deterministic domain-hash color.
 * Skips unsorted shelves. Fire-and-forget.
 */
async function _recomputeShelfColor(shelfId) {
  const [tabsMap, shelvesMap] = await Promise.all([Store.getTabs(), Store.getShelves()]);
  const shelf = shelvesMap[shelfId];
  if (!shelf || shelf.isUnsorted) return;

  const shelfTabs = Object.values(tabsMap).filter(t => t.shelfId === shelfId);
  if (!shelfTabs.length) return;

  // Merge frequency maps from each unique favicon URL
  const combined = new Map();
  const seenUrls = new Set();
  for (const tab of shelfTabs) {
    const url = tab.favIconUrl;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const freq = await _colorFreqFromFavicon(url);
    if (!freq) continue;
    for (const [hex, count] of freq) combined.set(hex, (combined.get(hex) || 0) + count);
  }

  const color = _pickDominantColor(combined);
  if (color) {
    await Store.setShelf(shelfId, { color });
    broadcast({ type: 'shelves_updated' });
    return;
  }

  // Fallback to domain hash color
  const domain = shelf.faviconDomain || _extractDomain(shelfTabs[0]?.url || '');
  if (domain) {
    await Store.setShelf(shelfId, { color: _domainColor(domain) });
    broadcast({ type: 'shelves_updated' });
  }
}

/**
 * Finds or creates a shelf for the given domain, assigns the tab to it,
 * then runs fit-score computation so the classifier can suggest better shelves.
 */
async function _assignByFavicon(nUrl) {
  const tabsMap        = await Store.getTabs();
  const tab            = tabsMap[nUrl];
  if (!tab) return;

  const existingShelves = await Store.getShelves();
  const domain          = _extractDomain(tab.favIconUrl || tab.url);

  let shelf = Object.values(existingShelves).find(s => !s.isUnsorted && s.faviconDomain === domain);
  if (!shelf) {
    const id = generateId();
    shelf = {
      id, faviconDomain: domain,
      title: domain ? _domainToTitle(domain) : 'Other',
      customTitle: null,
      color: domain ? _domainColor(domain) : '#94a3b8',
      order: Object.keys(existingShelves).length,
      isUnsorted: false,
    };
    await Store.setShelf(shelf.id, shelf);
  }

  await Store.setTab(nUrl, { shelfId: shelf.id });
  await _refreshFitScores([shelf.id]);
  broadcast({ type: 'shelves_updated' });
}

/**
 * Batch version: groups all tabs by favicon domain, creates shelves,
 * then runs fit scores so the classifier can suggest improvements.
 */
async function _reclassifyAll() {
  const tabsMap         = await Store.getTabs();
  const allTabs         = Object.values(tabsMap);
  if (allTabs.length === 0) return;

  const existingShelves  = await Store.getShelves();
  const shelvesToSave    = { ...existingShelves };
  const updated          = { ...tabsMap };

  for (const tab of allTabs) {
    const domain = _extractDomain(tab.favIconUrl || tab.url);
    let shelf = Object.values(shelvesToSave).find(s => !s.isUnsorted && s.faviconDomain === domain);
    if (!shelf) {
      const id = generateId();
      shelf = {
        id, faviconDomain: domain,
        title: domain ? _domainToTitle(domain) : 'Other',
        customTitle: null,
        color: domain ? _domainColor(domain) : '#94a3b8',
        order: Object.keys(shelvesToSave).length,
        isUnsorted: false,
      };
      shelvesToSave[shelf.id] = shelf;
    }
    updated[tab.normalizedUrl] = { ...updated[tab.normalizedUrl], shelfId: shelf.id };
  }

  await Store.setShelves(shelvesToSave);
  await chrome.storage.local.set({ shelve_tabs: updated });
  await _refreshFitScores();
  broadcast({ type: 'shelves_updated' });
}

/**
 * Recomputes fit scores for all tabs (or only those in the given shelf IDs).
 * Updates fitScore and suggestedShelfId on each affected tab in storage.
 */
async function _refreshFitScores(affectedShelfIds = null) {
  const tabsMap    = await Store.getTabs();
  const shelvesMap = await Store.getShelves();
  const allTabs    = Object.values(tabsMap);
  if (allTabs.length === 0) return;

  const scores = await Promise.resolve(Classifier.computeFitScores(allTabs, shelvesMap));

  // Only update tabs that are in the affected shelves (or all if null)
  const updatedTabs = { ...tabsMap };
  for (const [nUrl, score] of scores) {
    if (affectedShelfIds && !affectedShelfIds.includes(tabsMap[nUrl]?.shelfId)) continue;
    updatedTabs[nUrl] = { ...updatedTabs[nUrl], ...score };
  }
  await chrome.storage.local.set({ shelve_tabs: updatedTabs });
}

// ─── Archive page ─────────────────────────────────────────────────────────────

async function openArchivePage() {
  const archiveUrl = chrome.runtime.getURL('archive/archive.html');
  const existing = await chrome.tabs.query({ url: archiveUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: archiveUrl });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // ignore "no receivers" errors
}

function showNotification(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.svg'),
    title: 'Shelve',
    message,
  }).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


function truncateTitle(title, max) {
  if (!title || title.length <= max) return title || '';
  return title.slice(0, max).trimEnd() + '…';
}

/**
 * Returns true if the captured data-URI contains a meaningful (non-blank) image.
 * Decodes the image at low resolution and measures luminance standard deviation —
 * an all-black or all-white frame (unrendered tab) scores near zero.
 */
async function _isMeaningfulCapture(raw) {
  if (!raw || raw.length < 100) return false;
  try {
    const blob = await fetch(raw).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    const W = 32, H = 18;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const n = W * H;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
    }
    const mean = sum / n;
    const stdDev = Math.sqrt(sumSq / n - mean * mean);
    // Blank frames (black/white/grey solid) have stdDev ≈ 0; real pages > 5
    return stdDev > 5;
  } catch {
    return false;
  }
}

/**
 * Resizes a captured screenshot data-URI to the target dimensions using OffscreenCanvas.
 * Falls back to returning the original if OffscreenCanvas is unavailable.
 */
async function resizeThumbnail(dataUri, width, height) {
  try {
    const resp = await fetch(dataUri);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // Crop to aspect ratio then scale
    const srcAspect = bitmap.width / bitmap.height;
    const dstAspect = width / height;
    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    if (srcAspect > dstAspect) {
      sw = bitmap.height * dstAspect;
      sx = (bitmap.width - sw) / 2;
    } else {
      sh = bitmap.width / dstAspect;
      sy = 0; // Keep top of page
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(outBlob);
    });
  } catch {
    return dataUri;
  }
}
