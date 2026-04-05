/**
 * Archive page — main script
 * Handles shelves view, shelf detail view, search, drag-and-drop, editing.
 */

import { search as fuzzySearch } from '../lib/fuzzy-search.js';
import { relativeTime } from '../lib/utils.js';
import { MISMATCH_THRESHOLD } from '../lib/classifier.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const UNSORTED_ID = 'unsorted';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  view: 'shelves',         // 'shelves' | 'shelf'
  activeShelfId: null,
  tabs: {},
  shelves: {},
  thumbnails: {},
  tabOrders: {},           // shelfId → [normalizedUrl, ...]
  searchQuery: '',
  customShelfOrder: null,  // string[] of shelfIds when user has dragged, null = alphabetical
  listView: localStorage.getItem('shelve_list_view') === '1',
};

// ─── Element refs ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const viewShelves      = $('view-shelves');
const viewShelf        = $('view-shelf');
const shelvesGrid      = $('shelves-grid');
const tabsGrid         = $('tabs-grid');
const emptyShelves     = $('empty-shelves');
const emptyTabs        = $('empty-tabs');
const searchInput      = $('search-input');
const searchClear      = $('search-clear');
const btnBack          = $('btn-back');
const btnToggleView    = $('btn-toggle-view');
const btnSettings      = $('btn-settings');
const btnDeleteAll     = $('btn-delete-all');
const btnDeleteAllTabs = $('btn-delete-all-tabs');
const btnResetOrder    = $('btn-reset-order');
const btnNewShelf         = $('btn-new-shelf');
const btnOpenAllSame      = $('btn-open-all-same');
const btnOpenAllNew       = $('btn-open-all-new');
const btnOpenColTabsSame  = $('btn-open-col-tabs-same');
const btnOpenColTabsNew   = $('btn-open-col-tabs-new');
const shelfTitle       = $('shelf-title');
const shelfColorDot    = $('shelf-color-dot');
const shelfColorInput  = $('shelf-color-input');
const btnEditShelfTitle  = $('btn-edit-shelf-title');
const btnRevertShelf     = $('btn-revert-shelf');
const brandName        = $('brand-name');
const tabCountBadge    = $('tab-count-badge');

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await applyTheme();
  await loadData();
  btnDeleteAll.classList.remove('hidden'); // shelves view is the initial view
  btnResetOrder.classList.toggle('hidden', !state.customShelfOrder);
  btnNewShelf.classList.remove('hidden');
  btnOpenAllSame.classList.remove('hidden');
  btnOpenAllNew.classList.remove('hidden');
  applyListView();
  renderShelves();
  bindEvents();

  // Listen for SW updates
  chrome.runtime.onMessage.addListener(msg => {
    if (['tabs_updated', 'shelves_updated', 'archive_done', 'rearchive_done'].includes(msg.type)) {
      loadData().then(renderCurrentView);
    }
    if (msg.type === 'settings_updated') applyTheme();
  });

  // React to cross-device storage changes
  chrome.storage.onChanged.addListener((_, area) => {
    if (area === 'local') loadData().then(renderCurrentView);
  });
});

// ─── Data loading ─────────────────────────────────────────────────────────────

let _loadSeq = 0;

async function loadData() {
  const seq = ++_loadSeq;
  const [tabsRes, shelvesRes, thumbsRes, ordersRes, shelfOrderRes] = await Promise.all([
    chrome.storage.local.get('shelve_tabs'),
    chrome.storage.local.get('shelve_collections'),
    chrome.storage.local.get('shelve_thumbnails'),
    chrome.storage.local.get('shelve_tab_orders'),
    chrome.storage.local.get('shelve_col_order'),
  ]);
  if (seq !== _loadSeq) return; // a newer loadData is in flight; discard stale results
  state.tabs           = tabsRes.shelve_tabs           || {};
  state.shelves        = shelvesRes.shelve_collections || {};
  state.thumbnails     = thumbsRes.shelve_thumbnails   || {};
  state.tabOrders      = ordersRes.shelve_tab_orders   || {};
  state.customShelfOrder = shelfOrderRes.shelve_col_order || null;

  // Count only tabs that are visible (assigned to an existing shelf).
  // Orphaned tabs (shelfId null or pointing to a deleted shelf) are
  // shown under Unsorted but still counted here via the fallback below.
  const tabCount = Object.keys(state.tabs).length;
  tabCountBadge.textContent = tabCount > 0 ? String(tabCount) : '';
  tabCountBadge.title = `${tabCount} shelved tab${tabCount !== 1 ? 's' : ''}`;
}

// ─── Theme ────────────────────────────────────────────────────────────────────

async function applyTheme() {
  const settings = await chrome.storage.local.get('shelve_settings');
  const mode = settings.shelve_settings?.darkMode || 'system';
  const html = document.documentElement;
  if (mode === 'dark') {
    html.setAttribute('data-theme', 'dark');
    localStorage.setItem('shelve_theme', 'dark');
  } else if (mode === 'light') {
    html.setAttribute('data-theme', 'light');
    localStorage.setItem('shelve_theme', 'light');
  } else {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const t = mq.matches ? 'dark' : 'light';
    html.setAttribute('data-theme', t);
    localStorage.setItem('shelve_theme', t);
    mq.onchange = e => {
      const next = e.matches ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      localStorage.setItem('shelve_theme', next);
    };
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function showShelvesView() {
  state.view = 'shelves';
  state.activeShelfId = null;
  viewShelves.classList.remove('hidden');
  viewShelf.classList.add('hidden');
  btnBack.classList.add('hidden');
  btnDeleteAll.classList.remove('hidden');
  btnDeleteAllTabs.classList.add('hidden');
  btnResetOrder.classList.toggle('hidden', !state.customShelfOrder);
  btnNewShelf.classList.remove('hidden');
  btnOpenAllSame.classList.remove('hidden');
  btnOpenAllNew.classList.remove('hidden');
  btnOpenColTabsSame.classList.add('hidden');
  btnOpenColTabsNew.classList.add('hidden');
  brandName.textContent = 'Shelve';
  searchInput.placeholder = 'Search everything…';
  renderShelves();
}

function showShelfView(shelfId) {
  state.view = 'shelf';
  state.activeShelfId = shelfId;
  viewShelves.classList.add('hidden');
  viewShelf.classList.remove('hidden');
  btnBack.classList.remove('hidden');
  btnDeleteAll.classList.add('hidden');
  btnDeleteAllTabs.classList.remove('hidden');
  btnResetOrder.classList.toggle('hidden', !(state.tabOrders[shelfId]?.length));
  btnNewShelf.classList.add('hidden');
  btnOpenAllSame.classList.add('hidden');
  btnOpenAllNew.classList.add('hidden');
  btnOpenColTabsSame.classList.remove('hidden');
  btnOpenColTabsNew.classList.remove('hidden');
  renderShelf(shelfId);
}

function renderCurrentView() {
  if (state.view === 'shelves') renderShelves();
  else if (state.activeShelfId) renderShelf(state.activeShelfId);
}

// ─── Shelves view ─────────────────────────────────────────────────────────────

function renderShelves() {
  const shelves = orderedShelves();
  const tabsArr = Object.values(state.tabs);
  shelvesGrid.innerHTML = '';

  const shelvesArr = Object.values(state.shelves);
  if (tabsArr.length === 0 && shelvesArr.length === 0) {
    emptyShelves.classList.remove('hidden');
    return;
  }
  emptyShelves.classList.add('hidden');

  const knownShelfIds = new Set(Object.keys(state.shelves));

  // Bucket every tab into exactly one shelf.
  // Any tab whose shelfId is missing or points to an unknown shelf
  // falls into the reserved 'unsorted' bucket.
  const buckets = new Map(); // shelfId → tab[]
  for (const tab of tabsArr) {
    const shelfId = (tab.shelfId && knownShelfIds.has(tab.shelfId))
      ? tab.shelfId
      : UNSORTED_ID;
    if (!buckets.has(shelfId)) buckets.set(shelfId, []);
    buckets.get(shelfId).push(tab);
  }

  const tpl = document.getElementById('tpl-shelf-card');

  function renderShelfCard(shelf, shelfTabs) {
    const card = tpl.content.cloneNode(true).querySelector('.shelf-card');
    card.dataset.shelfId = shelf.id;
    card.querySelector('.shelf-card-accent').style.background = shelf.color || '#94a3b8';
    card.querySelector('.shelf-card-title').textContent = shelf.customTitle || shelf.title || 'Unnamed';
    card.querySelector('.shelf-card-count').textContent = shelfTabs.length === 0 ? 'empty' : `${shelfTabs.length} tab${shelfTabs.length !== 1 ? 's' : ''}`;

    // Mismatch badge
    const mismatchCount = shelfTabs.filter(t => isMismatched(t)).length;
    const mismatchBadge = card.querySelector('.shelf-mismatch-badge');
    if (mismatchCount > 0 && !shelf.isUnsorted) {
      mismatchBadge.classList.remove('hidden');
      mismatchBadge.title = `${mismatchCount} tab${mismatchCount !== 1 ? 's' : ''} may fit better elsewhere`;
    }

    // Open-all buttons — only stop propagation when there are tabs to open,
    // so clicking them on an empty shelf falls through to the card click handler.
    const shelfUrls = shelfTabs.map(t => t.url).filter(Boolean);
    card.querySelector('.btn-open-shelf-same').addEventListener('click', e => {
      if (!shelfUrls.length) return;
      e.stopPropagation();
      openTabs(shelfUrls, false);
    });
    card.querySelector('.btn-open-shelf-new').addEventListener('click', e => {
      if (!shelfUrls.length) return;
      e.stopPropagation();
      openTabs(shelfUrls, true);
    });

    // Delete shelf button
    const btnDel = card.querySelector('.btn-delete-shelf');
    if (shelf.isUnsorted) {
      btnDel.remove();
    } else {
      btnDel.addEventListener('click', async e => {
        e.stopPropagation();
        const label = shelf.customTitle || shelf.title || 'this shelf';
        const msg   = `Delete "${label}" and all ${shelfTabs.length} tab${shelfTabs.length !== 1 ? 's' : ''} inside it? This cannot be undone.`;
        if (!await confirmDialog(msg, 'Delete')) return;
        await chrome.runtime.sendMessage({ action: 'delete_shelf', id: shelf.id });
      });
    }

    // Preview thumbnails (up to 4)
    const thumbWrap = card.querySelector('.shelf-card-thumbs');
    for (const t of shelfTabs.slice(0, 4)) {
      const thumb = state.thumbnails[t.normalizedUrl];
      if (thumb) {
        const img = document.createElement('img');
        img.src = thumb;
        img.className = 'shelf-card-thumb';
        img.alt = t.title || '';
        thumbWrap.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'shelf-card-thumb-placeholder';
        ph.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>`;
        thumbWrap.appendChild(ph);
      }
    }

    // Favicon strip — unique favicons sorted alphabetically by tab title
    // Rendered into two containers: header (list view) and body (grid view)
    const faviconWrapHeader = card.querySelector('.shelf-card-favicons');
    const faviconWrapGrid   = card.querySelector('.shelf-card-favicons-grid');
    const seen = new Set();
    const sorted = [...shelfTabs].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    for (const t of sorted) {
      const key = t.favIconUrl || '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      for (const wrap of [faviconWrapHeader, faviconWrapGrid]) {
        const img = document.createElement('img');
        img.src = key;
        img.className = 'shelf-card-favicon';
        img.alt = t.title || '';
        img.title = t.title || '';
        img.onerror = () => img.remove();
        wrap.appendChild(img);
      }
    }

    card.addEventListener('click', e => {
      if (e.target.closest('.btn-delete-shelf, .btn-open-shelf-same, .btn-open-shelf-new')) return;
      showShelfView(shelf.id);
    });
    shelvesGrid.appendChild(card);
  }

  // Render real (non-unsorted) shelves from buckets
  for (const shelf of shelves) {
    if (shelf.isUnsorted) continue;
    renderShelfCard(shelf, buckets.get(shelf.id) || []);
  }

  // Render Unsorted: its own bucket (explicit assignments + orphans)
  const unsortedShelf = shelves.find(s => s.isUnsorted) || {
    id: UNSORTED_ID, title: 'Unsorted', customTitle: null,
    color: '#94a3b8', order: 9999, isUnsorted: true,
  };
  renderShelfCard(unsortedShelf, buckets.get(UNSORTED_ID) || []);

  applyShelfSearch(state.searchQuery);
  bindShelfDrag();
}

// ─── Shelf detail view ───────────────────────────────────────────────────

function renderShelf(shelfId) {
  const shelf = state.shelves[shelfId] || (shelfId === UNSORTED_ID
    ? { id: UNSORTED_ID, title: 'Unsorted', customTitle: null, color: '#94a3b8', isUnsorted: true }
    : null);
  if (!shelf) { showShelvesView(); return; }

  const title = shelf.customTitle || shelf.title || 'Unnamed';
  shelfTitle.textContent = title;
  shelfTitle.dataset.originalTitle = shelf.title || '';
  shelfTitle.dataset.customTitle   = shelf.customTitle || '';
  shelfTitle.dataset.originalColor = shelf.originalColor || shelf.color || '#4f46e5';
  shelfTitle.contentEditable = 'false';
  shelfColorDot.style.background = shelf.color || '#4f46e5';
  shelfColorInput.value = shelf.color || '#4f46e5';
  brandName.textContent = title;
  _updateShelfRevertBtn(shelf);
  searchInput.placeholder = `Search in "${title}"…`;

  // Get ordered tabs
  const tabsInShelf = tabsForShelf(shelfId);
  tabsGrid.innerHTML = '';

  if (tabsInShelf.length === 0) {
    emptyTabs.classList.remove('hidden');
    return;
  }
  emptyTabs.classList.add('hidden');

  const tpl = document.getElementById('tpl-tab-card');
  for (const tab of tabsInShelf) {
    const card = tpl.content.cloneNode(true).querySelector('.tab-card');
    populateTabCard(card, tab);
    tabsGrid.appendChild(card);
  }

  applyTabSearch(state.searchQuery);
  bindTabDrag(shelfId);
}

function populateTabCard(card, tab) {
  card.dataset.nurl = tab.normalizedUrl;

  const thumb    = card.querySelector('.tab-thumb');
  const openLink = card.querySelector('.tab-open-overlay');
  const titleEl  = card.querySelector('.tab-title');
  const descEl   = card.querySelector('.tab-desc');
  const dateEl   = card.querySelector('.tab-date');
  const revertEl = card.querySelector('.tab-revert');

  const imgData = state.thumbnails[tab.normalizedUrl];
  const thumbPlaceholder = card.querySelector('.tab-thumb-placeholder');
  if (imgData) {
    thumb.src = imgData;
    thumb.alt = tab.title || '';
    thumbPlaceholder.style.display = 'none';
    thumb.onerror = () => { thumb.remove(); thumbPlaceholder.style.display = ''; };
  } else {
    thumb.remove();
  }

  openLink.href = tab.url;
  openLink.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    chrome.tabs.create({ url: tab.url, active: false });
  });

  const dispTitle = tab.customTitle || tab.title || 'Untitled';
  const dispDesc  = tab.customDescription || tab.description || '';
  titleEl.textContent = dispTitle;
  descEl.textContent  = dispDesc;
  dateEl.textContent  = tab.lastArchived ? relativeTime(tab.lastArchived) : '';

  const btnRevertTitle = card.querySelector('.btn-revert-tab-title');

  // Show revert button if there are custom values
  if (tab.customTitle || tab.customDescription) {
    revertEl.classList.remove('hidden');
  }
  if (tab.customTitle) {
    btnRevertTitle.classList.remove('hidden');
  }

  // ── Mismatch notice ──────────────────────────────────────────────────────
  const mismatchEl      = card.querySelector('.tab-mismatch');
  const mismatchText    = card.querySelector('.tab-mismatch-text');
  const btnMoveSugg     = card.querySelector('.btn-move-suggested');
  const btnNewShelfSugg = card.querySelector('.btn-new-shelf-suggested');
  const suggestedShelf  = tab.suggestedShelfId ? state.shelves[tab.suggestedShelfId] : null;

  if (isMismatched(tab)) {
    card.classList.add('has-mismatch');
    mismatchEl.classList.remove('hidden');
    if (suggestedShelf) {
      const suggestedName = suggestedShelf.customTitle || suggestedShelf.title || 'another shelf';
      mismatchText.textContent = `May fit better in "${suggestedName}"`;
      btnMoveSugg.textContent  = `Move`;
      btnMoveSugg.title        = `Move to "${suggestedName}"`;
      btnMoveSugg.addEventListener('click', async e => {
        e.stopPropagation();
        await moveTab(tab, tab.suggestedShelfId);
      });
    } else {
      mismatchText.textContent = 'May not belong in this shelf';
      btnMoveSugg.classList.add('hidden');
      btnNewShelfSugg.classList.remove('hidden');
      btnNewShelfSugg.addEventListener('click', async e => {
        e.stopPropagation();
        const title = await promptDialog('New shelf name:', 'e.g. Reading list');
        if (!title) return;
        const newId = await createShelf(title);
        if (newId) {
          await loadData();
          await moveTab(tab, newId);
        }
      });
    }
  }

  // ── Move to another shelf ───────────────────────────────────────────
  const btnMove = card.querySelector('.btn-move-tab');
  btnMove.addEventListener('click', e => {
    e.stopPropagation();
    openShelfPicker(card, tab);
  });

  // ── Inline edit — title ──────────────────────────────────────────────────
  const btnEditTitle = card.querySelector('.btn-edit-tab-title');
  btnEditTitle.addEventListener('click', e => {
    e.stopPropagation();
    toggleEditField(titleEl, async newVal => {
      const isCustom = newVal !== tab.title;
      await chrome.runtime.sendMessage({
        action: 'update_tab',
        normalizedUrl: tab.normalizedUrl,
        data: { customTitle: isCustom ? newVal : null },
      });
      tab.customTitle = isCustom ? newVal : null;
      btnRevertTitle.classList.toggle('hidden', !tab.customTitle);
      revertEl.classList.toggle('hidden', !tab.customTitle && !tab.customDescription);
    });
  });

  btnRevertTitle.addEventListener('click', async e => {
    e.stopPropagation();
    await chrome.runtime.sendMessage({
      action: 'update_tab',
      normalizedUrl: tab.normalizedUrl,
      data: { customTitle: null },
    });
    tab.customTitle = null;
    titleEl.textContent = tab.title || 'Untitled';
    btnRevertTitle.classList.add('hidden');
    revertEl.classList.toggle('hidden', !tab.customDescription);
  });

  // ── Inline edit — description ───────────────────────────────────────────
  descEl.addEventListener('dblclick', () => {
    toggleEditField(descEl, async newVal => {
      const isCustom = newVal !== tab.description;
      await chrome.runtime.sendMessage({
        action: 'update_tab',
        normalizedUrl: tab.normalizedUrl,
        data: { customDescription: isCustom ? newVal : null },
      });
      tab.customDescription = isCustom ? newVal : null;
      revertEl.classList.toggle('hidden', !tab.customTitle && !tab.customDescription);
    });
  });

  // ── Revert ───────────────────────────────────────────────────────────────
  card.querySelector('.btn-revert').addEventListener('click', async e => {
    e.stopPropagation();
    await chrome.runtime.sendMessage({
      action: 'update_tab',
      normalizedUrl: tab.normalizedUrl,
      data: { customTitle: null, customDescription: null },
    });
    tab.customTitle = null;
    tab.customDescription = null;
    titleEl.textContent = tab.title || 'Untitled';
    descEl.textContent  = tab.description || '';
    revertEl.classList.add('hidden');
  });

  // ── Refresh ──────────────────────────────────────────────────────────────
  card.querySelector('.btn-refresh-tab').addEventListener('click', async e => {
    e.stopPropagation();
    card.classList.add('refreshing');
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      await chrome.runtime.sendMessage({ action: 'rearchive', url: tab.url });
    } finally {
      card.classList.remove('refreshing');
      card.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });

  // ── Delete ───────────────────────────────────────────────────────────────
  card.querySelector('.btn-delete-tab').addEventListener('click', async e => {
    e.stopPropagation();
    if (!await confirmDialog(`Remove "${tab.customTitle || tab.title}" from the archive?`)) return;
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.95)';
    setTimeout(async () => {
      await chrome.runtime.sendMessage({ action: 'delete_tab', normalizedUrl: tab.normalizedUrl });
    }, 200);
  });
}

// ─── Inline field editing ─────────────────────────────────────────────────────

function toggleEditField(el, onSave) {
  el.contentEditable = 'true';
  el.focus();
  // Select all text
  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  const finish = async () => {
    el.contentEditable = 'false';
    el.removeEventListener('blur', finish);
    el.removeEventListener('keydown', onKeydown);
    await onSave(el.textContent.trim());
  };
  const onKeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(); }
    if (e.key === 'Escape')               { el.contentEditable = 'false'; el.removeEventListener('blur', finish); }
  };
  el.addEventListener('blur', finish);
  el.addEventListener('keydown', onKeydown);
}

// ─── Shelf title & color editing ────────────────────────────────────────

let editingShelfTitle = false;

function bindShelfHeaderEditing() {
  btnEditShelfTitle.addEventListener('click', () => {
    if (!editingShelfTitle) {
      editingShelfTitle = true;
      shelfTitle.contentEditable = 'true';
      shelfTitle.focus();
      const range = document.createRange();
      range.selectNodeContents(shelfTitle);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });

  shelfTitle.addEventListener('blur', saveShelfTitle);
  shelfTitle.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); shelfTitle.blur(); }
    if (e.key === 'Escape') { shelfTitle.textContent = shelfTitle.dataset.originalTitle; shelfTitle.blur(); }
  });

  shelfColorDot.addEventListener('click', () => shelfColorInput.click());
  shelfColorInput.addEventListener('input', debounce(async () => {
    const color = shelfColorInput.value;
    shelfColorDot.style.background = color;
    await chrome.runtime.sendMessage({
      action: 'update_shelf',
      id: state.activeShelfId,
      data: { color },
    });
    const shelf = state.shelves[state.activeShelfId];
    if (shelf) shelf.color = color;
    _updateShelfRevertBtn(shelf);
  }, 300));

  btnRevertShelf.addEventListener('click', async () => {
    const shelf = state.shelves[state.activeShelfId];
    if (!shelf) return;
    const originalColor = shelfTitle.dataset.originalColor || shelf.color;
    await chrome.runtime.sendMessage({
      action: 'update_shelf',
      id: state.activeShelfId,
      data: { customTitle: null, color: originalColor },
    });
    shelf.customTitle = null;
    shelf.color = originalColor;
    shelfColorDot.style.background = originalColor;
    shelfColorInput.value = originalColor;
    const title = shelf.title || 'Unnamed';
    shelfTitle.textContent = title;
    brandName.textContent = title;
    _updateShelfRevertBtn(shelf);
  });
}

function _updateShelfRevertBtn(shelf) {
  if (!shelf) return;
  const originalColor = shelfTitle.dataset.originalColor || shelf.color;
  const hasCustomTitle = !!shelf.customTitle;
  const hasCustomColor = shelf.color !== originalColor;
  btnRevertShelf.classList.toggle('hidden', !hasCustomTitle && !hasCustomColor);
}

async function saveShelfTitle() {
  editingShelfTitle = false;
  shelfTitle.contentEditable = 'false';
  const newTitle = shelfTitle.textContent.trim();
  const shelf = state.shelves[state.activeShelfId];
  if (!shelf) return;
  const isCustom = newTitle !== shelf.title;
  shelf.customTitle = isCustom ? newTitle : null;
  brandName.textContent = newTitle;
  await chrome.runtime.sendMessage({
    action: 'update_shelf',
    id: state.activeShelfId,
    data: { customTitle: shelf.customTitle },
  });
  _updateShelfRevertBtn(shelf);
}

// ─── Search ───────────────────────────────────────────────────────────────────

function bindSearchEvents() {
  searchInput.addEventListener('input', debounce(() => {
    state.searchQuery = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !state.searchQuery);
    renderCurrentView();
  }, 200));

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClear.classList.add('hidden');
    renderCurrentView();
  });
}

function applyShelfSearch(query) {
  const allCards = [...shelvesGrid.querySelectorAll('.shelf-card')];
  if (!query) {
    allCards.forEach(c => c.classList.remove('search-hidden', 'search-match'));
    return;
  }

  const tabsArr = Object.values(state.tabs);
  const shelves = orderedShelves();

  const shelfSearchItems = shelves.map(shelf => {
    const shelfTabs = tabsArr.filter(t => t.shelfId === shelf.id);
    return {
      id: shelf.id,
      title: shelf.customTitle || shelf.title || '',
      content: shelfTabs.map(t => `${t.customTitle || t.title} ${t.customDescription || t.description} ${t.content || ''}`).join(' '),
    };
  });

  const results = fuzzySearch(query, shelfSearchItems, ['title', 'content'], { threshold: 0.25 });
  const matchIds = new Set(results.map(r => r.id));

  const matching    = allCards.filter(c =>  matchIds.has(c.dataset.shelfId));
  const nonMatching = allCards.filter(c => !matchIds.has(c.dataset.shelfId));

  matching.forEach(c => { c.classList.remove('search-hidden'); c.classList.add('search-match'); });
  nonMatching.forEach(c => { c.classList.add('search-hidden'); c.classList.remove('search-match'); });

  // Move matched cards to the top of the grid
  [...matching, ...nonMatching].forEach(c => shelvesGrid.appendChild(c));
}

function applyTabSearch(query) {
  const allCards = [...tabsGrid.querySelectorAll('.tab-card')];
  if (!query) {
    allCards.forEach(c => c.classList.remove('search-hidden', 'search-match'));
    return;
  }
  const tabsArr = tabsForShelf(state.activeShelfId);
  const items = tabsArr.map(t => ({
    nurl: t.normalizedUrl,
    title: t.customTitle || t.title || '',
    desc: t.customDescription || t.description || '',
    content: t.content || '',
  }));
  const results = fuzzySearch(query, items, ['title', 'desc', 'content'], { threshold: 0.25 });
  const matchNurls = new Set(results.map(r => r.nurl));

  const matching    = allCards.filter(c =>  matchNurls.has(c.dataset.nurl));
  const nonMatching = allCards.filter(c => !matchNurls.has(c.dataset.nurl));

  matching.forEach(c => { c.classList.remove('search-hidden'); c.classList.add('search-match'); });
  nonMatching.forEach(c => { c.classList.add('search-hidden'); c.classList.remove('search-match'); });

  [...matching, ...nonMatching].forEach(c => tabsGrid.appendChild(c));
}

// ─── Drag & drop — shelves ────────────────────────────────────────────────

function bindShelfDrag() {
  const cards = [...shelvesGrid.querySelectorAll('.shelf-card')];
  let dragging = null;

  cards.forEach(card => {
    card.addEventListener('dragstart', e => {
      dragging = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragging = null;
      saveShelfOrder();
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragging && dragging !== card) {
        card.classList.add('drag-over');
        const rect = card.getBoundingClientRect();
        const mid  = rect.top + rect.height / 2;
        if (e.clientY < mid) card.before(dragging);
        else                  card.after(dragging);
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over');
    });
  });
}

async function saveShelfOrder() {
  const cards = [...shelvesGrid.querySelectorAll('.shelf-card')];
  const order = cards.map(c => c.dataset.shelfId).filter(Boolean);
  state.customShelfOrder = order;
  await chrome.storage.local.set({ shelve_col_order: order });
  btnResetOrder.classList.remove('hidden');
}

async function resetShelfOrder() {
  state.customShelfOrder = null;
  await chrome.storage.local.remove('shelve_col_order');
  btnResetOrder.classList.add('hidden');
  renderShelves();
}

// ─── Drag & drop — tabs ───────────────────────────────────────────────────────

function bindTabDrag(colId) {
  const cards = [...tabsGrid.querySelectorAll('.tab-card')];
  let dragging = null;

  cards.forEach(card => {
    card.addEventListener('dragstart', e => {
      dragging = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragging = null;
      saveTabOrder(colId);
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragging && dragging !== card) {
        card.classList.add('drag-over');
        const rect = card.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) card.before(dragging);
        else card.after(dragging);
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop',      e => { e.preventDefault(); card.classList.remove('drag-over'); });
  });
}

async function saveTabOrder(shelfId) {
  const cards = [...tabsGrid.querySelectorAll('.tab-card')];
  const order = cards.map(c => c.dataset.nurl).filter(Boolean);
  state.tabOrders[shelfId] = order;
  await chrome.runtime.sendMessage({ action: 'set_tab_order', shelfId, order });
  btnResetOrder.classList.remove('hidden');
}

async function resetTabOrder(shelfId) {
  delete state.tabOrders[shelfId];
  await chrome.runtime.sendMessage({ action: 'set_tab_order', shelfId, order: [] });
  btnResetOrder.classList.add('hidden');
  renderShelf(shelfId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function orderedShelves() {
  const shelves = Object.values(state.shelves);
  return shelves.sort((a, b) => {
    // Unsorted is always last
    if (a.isUnsorted && !b.isUnsorted) return 1;
    if (!a.isUnsorted && b.isUnsorted) return -1;
    if (state.customShelfOrder) {
      // User has manually ordered — respect that order; new shelves go to the end
      const ia = state.customShelfOrder.indexOf(a.id);
      const ib = state.customShelfOrder.indexOf(b.id);
      const ra = ia === -1 ? Infinity : ia;
      const rb = ib === -1 ? Infinity : ib;
      if (ra !== rb) return ra - rb;
    }
    // Default (or tie-break for new shelves): alphabetical by display title
    const ta = (a.customTitle || a.title || '').toLowerCase();
    const tb = (b.customTitle || b.title || '').toLowerCase();
    return ta.localeCompare(tb);
  });
}

function tabsForShelf(shelfId) {
  const shelf = state.shelves[shelfId];
  const knownShelfIds = new Set(Object.keys(state.shelves));
  const isUnsorted = shelf?.isUnsorted || shelfId === 'unsorted';
  const all = isUnsorted
    ? Object.values(state.tabs).filter(t =>
        !t.shelfId || !knownShelfIds.has(t.shelfId) || t.shelfId === shelfId)
    : Object.values(state.tabs).filter(t => t.shelfId === shelfId);
  const order = state.tabOrders[shelfId];
  if (order && order.length) {
    const idx = new Map(order.map((u, i) => [u, i]));
    return all.sort((a, b) => {
      const ia = idx.has(a.normalizedUrl) ? idx.get(a.normalizedUrl) : Infinity;
      const ib = idx.has(b.normalizedUrl) ? idx.get(b.normalizedUrl) : Infinity;
      if (ia !== ib) return ia - ib;
      // New tabs not in the custom order → alphabetical at end
      return (a.customTitle || a.title || '').toLowerCase()
        .localeCompare((b.customTitle || b.title || '').toLowerCase());
    });
  }
  // Default: alphabetical by display title
  return all.sort((a, b) =>
    (a.customTitle || a.title || '').toLowerCase()
      .localeCompare((b.customTitle || b.title || '').toLowerCase())
  );
}

function applyListView() {
  shelvesGrid.classList.toggle('list-view', state.listView);
  tabsGrid.classList.toggle('list-view', state.listView);
  const iconGrid = btnToggleView.querySelector('.icon-grid');
  const iconList = btnToggleView.querySelector('.icon-list');
  if (iconGrid) iconGrid.style.display = state.listView ? '' : 'none';
  if (iconList) iconList.style.display = state.listView ? 'none' : '';
  btnToggleView.title = state.listView ? 'Switch to grid view' : 'Switch to list view';
  btnToggleView.setAttribute('aria-label', btnToggleView.title);
}

async function openTabs(urls, inNewWindow) {
  if (!urls.length) return;
  const CONFIRM_THRESHOLD = 2;
  if (urls.length >= CONFIRM_THRESHOLD) {
    const where = inNewWindow ? 'a new window' : 'this window';
    const ok = await confirmDialog(
      `Open ${urls.length} tabs in ${where}?`,
      `Open ${urls.length} tabs`
    );
    if (!ok) return;
  }
  if (inNewWindow) {
    chrome.windows.create({ url: urls });
  } else {
    urls.forEach(url => chrome.tabs.create({ url, active: false }));
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ─── Mismatch helpers ─────────────────────────────────────────────────────────

function isMismatched(tab) {
  if (tab.fitScore == null) return false;
  const shelf = state.shelves[tab.shelfId];
  if (shelf?.isUnsorted) return false;   // Unsorted tabs aren't "mismatched"
  return tab.fitScore < MISMATCH_THRESHOLD;
}

// ─── Shelf picker ────────────────────────────────────────────────────────────

let _activePicker = null;

function openShelfPicker(card, tab) {
  closeActivePicker();

  const picker = document.createElement('div');
  picker.className = 'shelf-picker';

  const header = document.createElement('div');
  header.className = 'shelf-picker-header';
  header.textContent = 'Move to…';
  picker.appendChild(header);

  // "New shelf…" option
  const newShelfItem = document.createElement('div');
  newShelfItem.className = 'shelf-picker-item shelf-picker-new';
  newShelfItem.innerHTML = `<span class="shelf-picker-new-icon">＋</span><span>New shelf…</span>`;
  newShelfItem.addEventListener('click', async e => {
    e.stopPropagation();
    closeActivePicker();
    const title = await promptDialog('New shelf name:', 'e.g. Reading list');
    if (!title) return;
    const newId = await createShelf(title);
    if (newId) {
      await loadData();
      await moveTab(tab, newId);
    }
  });
  picker.appendChild(newShelfItem);

  const unsortedShelf = Object.values(state.shelves).find(s => s.isUnsorted) ||
    { id: UNSORTED_ID, title: 'Unsorted', customTitle: null, color: '#94a3b8', isUnsorted: true };

  const shelves = [
    ...orderedShelves().filter(s => s.id !== tab.shelfId),
    ...(tab.shelfId !== UNSORTED_ID ? [unsortedShelf] : []),
  ];

  for (const shelf of shelves) {
    const item = document.createElement('div');
    item.className = 'shelf-picker-item';
    const isSuggested = shelf.id === tab.suggestedShelfId;
    if (isSuggested) item.classList.add('suggested');

    const dot = document.createElement('span');
    dot.className = 'shelf-picker-dot';
    dot.style.background = shelf.color || '#94a3b8';
    item.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = shelf.customTitle || shelf.title || 'Unnamed';
    item.appendChild(label);

    if (isSuggested) {
      const badge = document.createElement('span');
      badge.className = 'shelf-picker-suggested-badge';
      badge.textContent = 'Suggested';
      item.appendChild(badge);
    }

    item.addEventListener('click', async e => {
      e.stopPropagation();
      closeActivePicker();
      await moveTab(tab, shelf.id);
    });
    picker.appendChild(item);
  }

  document.body.appendChild(picker);
  _activePicker = picker;

  // Position: below the button by default, flip upward when near the bottom
  const btn   = card.querySelector('.btn-move-tab');
  const bRect = btn.getBoundingClientRect();
  const pickerH = Math.min(320, shelves.length * 38 + 32); // estimated height
  const spaceBelow = window.innerHeight - bRect.bottom;
  const spaceAbove = bRect.top;

  if (spaceBelow >= pickerH || spaceBelow >= spaceAbove) {
    // Open downward
    picker.style.top  = `${bRect.bottom + 4}px`;
  } else {
    // Open upward
    picker.style.top  = `${bRect.top - pickerH - 4}px`;
  }

  // Align right edge with button right edge, but keep within viewport
  const rightEdge = window.innerWidth - bRect.right;
  picker.style.right = `${Math.max(8, rightEdge)}px`;

  // Dismiss on outside click or Escape
  const onOutside = e => {
    if (!picker.contains(e.target) && e.target !== btn) {
      closeActivePicker();
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onEscape, true);
    }
  };
  const onEscape = e => {
    if (e.key === 'Escape') {
      closeActivePicker();
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onEscape, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onEscape, true);
  }, 0);
}

function closeActivePicker() {
  if (_activePicker) {
    _activePicker.remove();
    _activePicker = null;
  }
}

async function moveTab(tab, targetShelfId) {
  const sourceShelfId = tab.shelfId;
  // Optimistic UI update
  tab.shelfId               = targetShelfId;
  tab.fitScore              = null;
  tab.suggestedShelfId      = null;

  await chrome.runtime.sendMessage({
    action: 'move_tab_to_shelf',
    normalizedUrl: tab.normalizedUrl,
    targetShelfId,
    sourceShelfId,
  });
  // Re-render current view to reflect the move
  await loadData();
  renderCurrentView();
}

/** Promise-based confirm dialog (replaces window.confirm which is blocked in extensions). */
function confirmDialog(message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirm-overlay-archive');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-overlay-archive';
      overlay.innerHTML = `
        <div class="confirm-box-archive">
          <p class="confirm-msg-archive"></p>
          <div class="confirm-btns-archive">
            <button class="cbtn-cancel-archive">Cancel</button>
            <button class="cbtn-ok-archive">Remove</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      // Inline styles since we can't easily add to CSS here
      Object.assign(overlay.style, {
        position:'fixed', inset:0, background:'rgba(0,0,0,.45)',
        display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999
      });
      const box = overlay.querySelector('.confirm-box-archive');
      Object.assign(box.style, {
        background:'var(--bg-card)', borderRadius:'12px', padding:'20px 24px',
        maxWidth:'340px', width:'90%', boxShadow:'0 8px 30px rgba(0,0,0,.2)'
      });
      overlay.querySelector('.confirm-msg-archive').style.cssText = 'font-size:14px;margin-bottom:16px;line-height:1.5;color:var(--text)';
      overlay.querySelector('.confirm-btns-archive').style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
      ['.cbtn-cancel-archive', '.cbtn-ok-archive'].forEach(sel => {
        const b = overlay.querySelector(sel);
        Object.assign(b.style, { padding:'6px 16px', borderRadius:'7px', border:'none', cursor:'pointer', fontSize:'13px', fontWeight:'500' });
      });
      overlay.querySelector('.cbtn-cancel-archive').style.cssText += ';background:var(--border2);color:var(--text2)';
      overlay.querySelector('.cbtn-ok-archive').style.cssText += ';background:#dc2626;color:#fff';
    }

    overlay.querySelector('.confirm-msg-archive').textContent = message;
    overlay.querySelector('.cbtn-ok-archive').textContent = okLabel;
    overlay.style.display = 'flex';

    const onOk = () => { overlay.style.display = 'none'; cleanup(); resolve(true); };
    const onCancel = () => { overlay.style.display = 'none'; cleanup(); resolve(false); };
    const cleanup = () => {
      overlay.querySelector('.cbtn-ok-archive').removeEventListener('click', onOk);
      overlay.querySelector('.cbtn-cancel-archive').removeEventListener('click', onCancel);
    };
    overlay.querySelector('.cbtn-ok-archive').addEventListener('click', onOk);
    overlay.querySelector('.cbtn-cancel-archive').addEventListener('click', onCancel);
  });
}

/** Promise-based text-input dialog. Resolves with the trimmed string, or null on cancel. */
function promptDialog(message, placeholder = '') {
  return new Promise(resolve => {
    let overlay = document.getElementById('prompt-overlay-archive');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'prompt-overlay-archive';
      overlay.innerHTML = `
        <div class="confirm-box-archive">
          <p class="prompt-msg-archive"></p>
          <input class="prompt-input-archive" type="text" autocomplete="off" spellcheck="false">
          <div class="confirm-btns-archive" style="margin-top:12px">
            <button class="pbtn-cancel-archive">Cancel</button>
            <button class="pbtn-ok-archive">Create</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      Object.assign(overlay.style, {
        position:'fixed', inset:0, background:'rgba(0,0,0,.45)',
        display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999
      });
      const box = overlay.querySelector('.confirm-box-archive');
      Object.assign(box.style, {
        background:'var(--bg-card)', borderRadius:'12px', padding:'20px 24px',
        maxWidth:'340px', width:'90%', boxShadow:'0 8px 30px rgba(0,0,0,.2)'
      });
      overlay.querySelector('.prompt-msg-archive').style.cssText = 'font-size:14px;margin-bottom:10px;line-height:1.5;color:var(--text)';
      const inp = overlay.querySelector('.prompt-input-archive');
      Object.assign(inp.style, {
        width:'100%', padding:'7px 10px', borderRadius:'7px', fontSize:'14px',
        border:'1.5px solid var(--border2)', background:'var(--bg)', color:'var(--text)',
        outline:'none', boxSizing:'border-box',
      });
      overlay.querySelector('.confirm-btns-archive').style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
      ['.pbtn-cancel-archive', '.pbtn-ok-archive'].forEach(sel => {
        const b = overlay.querySelector(sel);
        Object.assign(b.style, { padding:'6px 16px', borderRadius:'7px', border:'none', cursor:'pointer', fontSize:'13px', fontWeight:'500' });
      });
      overlay.querySelector('.pbtn-cancel-archive').style.cssText += ';background:var(--border2);color:var(--text2)';
      overlay.querySelector('.pbtn-ok-archive').style.cssText += ';background:var(--accent);color:#fff';
    }

    overlay.querySelector('.prompt-msg-archive').textContent = message;
    const inp = overlay.querySelector('.prompt-input-archive');
    inp.value = '';
    inp.placeholder = placeholder;
    overlay.style.display = 'flex';
    setTimeout(() => inp.focus(), 50);

    const finish = val => {
      overlay.style.display = 'none';
      overlay.querySelector('.pbtn-ok-archive').removeEventListener('click', onOk);
      overlay.querySelector('.pbtn-cancel-archive').removeEventListener('click', onCancel);
      inp.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk     = () => { const v = inp.value.trim(); if (v) finish(v); };
    const onCancel = () => finish(null);
    const onKey    = e => { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); };
    overlay.querySelector('.pbtn-ok-archive').addEventListener('click', onOk);
    overlay.querySelector('.pbtn-cancel-archive').addEventListener('click', onCancel);
    inp.addEventListener('keydown', onKey);
  });
}

async function createShelf(title) {
  const resp = await chrome.runtime.sendMessage({ action: 'create_shelf', title });
  return resp?.id || null;
}

// ─── Events (top-level bindings) ──────────────────────────────────────────────

function bindEvents() {
  btnBack.addEventListener('click', showShelvesView);

  btnDeleteAll.addEventListener('click', async () => {
    const total = Object.keys(state.tabs).length;
    if (total === 0) return;
    const msg = `Permanently delete all ${total} shelved tab${total !== 1 ? 's' : ''} and every shelf? This cannot be undone.`;
    if (!await confirmDialog(msg, 'Delete all')) return;
    await chrome.runtime.sendMessage({ action: 'delete_all' });
  });

  btnDeleteAllTabs.addEventListener('click', async () => {
    const shelf = state.shelves[state.activeShelfId];
    const tabs  = Object.values(state.tabs).filter(t => t.shelfId === state.activeShelfId);
    if (tabs.length === 0) return;
    const label = shelf?.customTitle || shelf?.title || 'this shelf';
    const msg   = `Permanently delete all ${tabs.length} tab${tabs.length !== 1 ? 's' : ''} in "${label}"? This cannot be undone.`;
    if (!await confirmDialog(msg, 'Delete all tabs')) return;
    await chrome.runtime.sendMessage({ action: 'delete_shelf_tabs', shelfId: state.activeShelfId });
  });

  btnNewShelf.addEventListener('click', async () => {
    const title = await promptDialog('New shelf name:', 'e.g. Reading list');
    if (!title) return;
    await createShelf(title);
  });

  btnResetOrder.addEventListener('click', () => {
    if (state.view === 'shelves') resetShelfOrder();
    else if (state.activeShelfId)  resetTabOrder(state.activeShelfId);
  });

  btnOpenAllSame.addEventListener('click', () => {
    const urls = Object.values(state.tabs).map(t => t.url).filter(Boolean);
    openTabs(urls, false);
  });
  btnOpenAllNew.addEventListener('click', () => {
    const urls = Object.values(state.tabs).map(t => t.url).filter(Boolean);
    openTabs(urls, true);
  });

  btnOpenColTabsSame.addEventListener('click', () => {
    const urls = tabsForShelf(state.activeShelfId).map(t => t.url).filter(Boolean);
    openTabs(urls, false);
  });
  btnOpenColTabsNew.addEventListener('click', () => {
    const urls = tabsForShelf(state.activeShelfId).map(t => t.url).filter(Boolean);
    openTabs(urls, true);
  });

  btnToggleView.addEventListener('click', () => {
    state.listView = !state.listView;
    localStorage.setItem('shelve_list_view', state.listView ? '1' : '0');
    applyListView();
  });

  btnSettings.addEventListener('click', () => {
    location.href = chrome.runtime.getURL('settings/settings.html');
  });
  bindSearchEvents();
  bindShelfHeaderEditing();
}
