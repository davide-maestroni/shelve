/**
 * Storage Manager for Shelve
 *
 * Strategy:
 *  - chrome.storage.local  → primary store (all data: tabs, thumbnails, shelves)
 *  - chrome.storage.sync   → mirrors settings + tab/shelf metadata (no thumbnails or full content)
 *
 * On first load the sync store is merged into local, so a new device "catches up"
 * from another device's archived data. Thumbnails and full content are always local-only.
 */

const LOCAL = chrome.storage.local;
const SYNC  = chrome.storage.sync;

const KEY = {
  TABS:         'shelve_tabs',
  THUMBNAILS:   'shelve_thumbnails',
  COLLECTIONS:  'shelve_collections',  // storage key unchanged for data compatibility
  SETTINGS:     'shelve_settings',
  TAB_ORDERS:   'shelve_tab_orders',   // per-shelf custom sort
};

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings() {
  const [local, synced] = await Promise.all([
    LOCAL.get(KEY.SETTINGS),
    SYNC.get(KEY.SETTINGS).catch(() => ({})),
  ]);
  return { darkMode: 'system', ...(local[KEY.SETTINGS] || {}), ...(synced[KEY.SETTINGS] || {}) };
}

export async function setSettings(data) {
  await Promise.all([
    LOCAL.set({ [KEY.SETTINGS]: data }),
    SYNC.set({ [KEY.SETTINGS]: data }).catch(() => {}),
  ]);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

export async function getTabs() {
  const result = await LOCAL.get(KEY.TABS);
  return result[KEY.TABS] || {};
}

export async function getTab(normalizedUrl) {
  const tabs = await getTabs();
  return tabs[normalizedUrl] || null;
}

export async function setTab(normalizedUrl, data) {
  const tabs = await getTabs();
  tabs[normalizedUrl] = { ...tabs[normalizedUrl], ...data, normalizedUrl };
  await LOCAL.set({ [KEY.TABS]: tabs });
  // Sync metadata (no content/thumbnails)
  _syncTabMeta(tabs[normalizedUrl]).catch(() => {});
}

export async function removeTab(normalizedUrl) {
  const [tabs, thumbnails, orders] = await Promise.all([
    getTabs(),
    getThumbnails(),
    getTabOrders(),
  ]);
  delete tabs[normalizedUrl];
  delete thumbnails[normalizedUrl];
  // Remove from all collection orders
  for (const colId of Object.keys(orders)) {
    orders[colId] = (orders[colId] || []).filter(u => u !== normalizedUrl);
  }
  await LOCAL.set({ [KEY.TABS]: tabs, [KEY.THUMBNAILS]: thumbnails, [KEY.TAB_ORDERS]: orders });
  SYNC.remove(`shelve_tabmeta_${_syncKey(normalizedUrl)}`).catch(() => {});
}

async function _syncTabMeta(tab) {
  const meta = {
    url: tab.url,
    normalizedUrl: tab.normalizedUrl,
    title: tab.title,
    customTitle: tab.customTitle ?? null,
    description: tab.description,
    customDescription: tab.customDescription ?? null,
    firstArchived: tab.firstArchived,
    lastArchived: tab.lastArchived,
    shelfId: tab.shelfId,
  };
  const key = `shelve_tabmeta_${_syncKey(tab.normalizedUrl)}`;
  await SYNC.set({ [key]: meta });
}

function _syncKey(normalizedUrl) {
  let h = 5381;
  for (let i = 0; i < normalizedUrl.length; i++) h = ((h << 5) + h) ^ normalizedUrl.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ─── Thumbnails ───────────────────────────────────────────────────────────────

export async function getThumbnails() {
  const result = await LOCAL.get(KEY.THUMBNAILS);
  return result[KEY.THUMBNAILS] || {};
}

export async function getThumbnail(normalizedUrl) {
  const t = await getThumbnails();
  return t[normalizedUrl] || null;
}

export async function setThumbnail(normalizedUrl, dataUri) {
  const t = await getThumbnails();
  t[normalizedUrl] = dataUri;
  await LOCAL.set({ [KEY.THUMBNAILS]: t }).catch(e => {
    console.error('[Shelve] setThumbnail failed (storage quota?):', e.message);
    throw e;
  });
}

// ─── Shelves ─────────────────────────────────────────────────────────────────

export async function getShelves() {
  const result = await LOCAL.get(KEY.COLLECTIONS);
  return result[KEY.COLLECTIONS] || {};
}

export async function setShelves(shelvesMap) {
  await LOCAL.set({ [KEY.COLLECTIONS]: shelvesMap });
  SYNC.set({ [KEY.COLLECTIONS]: shelvesMap }).catch(() => {});
}

export async function setShelf(id, data) {
  const shelves = await getShelves();
  shelves[id] = { ...shelves[id], ...data, id };
  await setShelves(shelves);
}

export async function removeShelf(id) {
  const shelves = await getShelves();
  delete shelves[id];
  await setShelves(shelves);
}

// ─── Tab ordering within shelves ─────────────────────────────────────────────

export async function getTabOrders() {
  const result = await LOCAL.get(KEY.TAB_ORDERS);
  return result[KEY.TAB_ORDERS] || {};
}

export async function setTabOrder(shelfId, orderedUrls) {
  const orders = await getTabOrders();
  orders[shelfId] = orderedUrls;
  await LOCAL.set({ [KEY.TAB_ORDERS]: orders });
  SYNC.set({ [KEY.TAB_ORDERS]: orders }).catch(() => {});
}

// ─── Cross-device sync bootstrap ─────────────────────────────────────────────

/**
 * Called once on extension startup / install.
 * Merges any sync data onto local (other device may have archived tabs we don't have).
 */
export async function bootstrapFromSync() {
  try {
    const syncData = await SYNC.get(null);
    const tabs = await getTabs();
    let changed = false;

    for (const [key, value] of Object.entries(syncData)) {
      if (key.startsWith('shelve_tabmeta_')) {
        const url = value.normalizedUrl;
        if (url && !tabs[url]) {
          // We have metadata from another device but no local copy
          tabs[url] = { ...value, content: '', _syncOnly: true };
          changed = true;
        }
      }
    }
    if (changed) await LOCAL.set({ [KEY.TABS]: tabs });

    // Merge shelves
    if (syncData[KEY.COLLECTIONS]) {
      const localShelves = await getShelves();
      const merged = { ...syncData[KEY.COLLECTIONS], ...localShelves };
      await LOCAL.set({ [KEY.COLLECTIONS]: merged });
    }

    // Merge tab orders
    if (syncData[KEY.TAB_ORDERS]) {
      const localOrders = await getTabOrders();
      const merged = { ...syncData[KEY.TAB_ORDERS], ...localOrders };
      await LOCAL.set({ [KEY.TAB_ORDERS]: merged });
    }
  } catch (e) {
    console.warn('[Shelve] bootstrapFromSync failed:', e);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns tabs grouped by shelfId (shelf), respecting custom ordering. */
export async function getTabsByShelf(shelfId) {
  const [tabs, orders] = await Promise.all([getTabs(), getTabOrders()]);
  const all = Object.values(tabs).filter(t => t.shelfId === shelfId);
  const order = orders[shelfId];
  if (!order) return all.sort((a, b) => (b.lastArchived || 0) - (a.lastArchived || 0));
  const idx = new Map(order.map((u, i) => [u, i]));
  return all.sort((a, b) => {
    const ia = idx.has(a.normalizedUrl) ? idx.get(a.normalizedUrl) : Infinity;
    const ib = idx.has(b.normalizedUrl) ? idx.get(b.normalizedUrl) : Infinity;
    return ia - ib;
  });
}

/** Returns ordered shelves array respecting user-set order. */
export async function getOrderedShelves() {
  const shelves = await getShelves();
  return Object.values(shelves).sort((a, b) => {
    if (a.isUncategorized && !b.isUncategorized) return 1;
    if (!a.isUncategorized && b.isUncategorized) return -1;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}
