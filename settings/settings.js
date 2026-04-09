/**
 * Settings page
 */

import { applyTheme, applyThemeFromMode } from '../lib/theme.js';

document.addEventListener('DOMContentLoaded', async () => {
  await applyTheme();
  await loadSettings();

  document.getElementById('btn-back').addEventListener('click', e => {
    e.preventDefault();
    location.href = chrome.runtime.getURL('archive/archive.html');
  });

  // ── Dark mode ────────────────────────────────────────────────────────────
  const control = document.getElementById('dark-mode-control');
  control.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const value = btn.dataset.value;
      setActiveSegment(control, value);
      await saveSettings({ darkMode: value });
      applyThemeFromMode(value);
    });
  });

  // ── Auto-fetch toggle ────────────────────────────────────────────────────
  const toggle = document.getElementById('auto-fetch-toggle');
  toggle.addEventListener('click', async () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next));
    await saveSettings({ autoFetchMissing: next });
  });

  // ── Switch focus toggle ───────────────────────────────────────────────────
  const switchFocusToggle = document.getElementById('switch-focus-toggle');
  switchFocusToggle.addEventListener('click', async () => {
    const next = switchFocusToggle.getAttribute('aria-checked') !== 'true';
    switchFocusToggle.setAttribute('aria-checked', String(next));
    await saveSettings({ switchFocus: next });
  });

  // ── Fetch now button ─────────────────────────────────────────────────────
  document.getElementById('btn-fetch-now').addEventListener('click', startFetch);
  document.getElementById('btn-cancel-fetch').addEventListener('click', cancelFetch);

  // ── Storage usage ─────────────────────────────────────────────────────────
  loadStorageUsage();

  document.getElementById('btn-clear-thumbnails').addEventListener('click', () =>
    clearStorage('clear_thumbnails', 'Delete all thumbnails? They can be re-fetched later if focus switching is enabled.')
  );
  document.getElementById('btn-clear-content').addEventListener('click', () =>
    clearStorage('clear_content', 'Delete all cached page text? It can be re-fetched using "Fetch missing data".')
  );
  document.getElementById('btn-clear-both').addEventListener('click', () =>
    clearStorage('clear_thumbnails_and_content', 'Delete all thumbnails and cached page text?')
  );

  // ── Listen for progress from service worker ──────────────────────────────
  chrome.runtime.onMessage.addListener(onMessage);
});

async function loadSettings() {
  const res = await chrome.storage.local.get('shelve_settings');
  const settings = res.shelve_settings || {};

  const mode = settings.darkMode || 'system';
  setActiveSegment(document.getElementById('dark-mode-control'), mode);

  const toggle = document.getElementById('auto-fetch-toggle');
  toggle.setAttribute('aria-checked', String(!!settings.autoFetchMissing));

  const switchFocusToggle = document.getElementById('switch-focus-toggle');
  switchFocusToggle.setAttribute('aria-checked', String(!!settings.switchFocus));
}

async function saveSettings(partial) {
  const res = await chrome.storage.local.get('shelve_settings');
  const current = res.shelve_settings || {};
  const updated = { ...current, ...partial };
  // Delegate to service worker which saves + broadcasts to all pages
  await chrome.runtime.sendMessage({ action: 'set_settings', settings: updated }).catch(async () => {
    // Fallback: save directly if SW is unavailable
    await chrome.storage.local.set({ shelve_settings: updated });
    chrome.storage.sync.set({ shelve_settings: updated }).catch(() => {});
  });
}

function setActiveSegment(control, value) {
  control.querySelectorAll('.seg-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.value === value ? 'true' : 'false');
  });
}

// ─── Fetch missing data ───────────────────────────────────────────────────────

async function startFetch() {
  const btn   = document.getElementById('btn-fetch-now');
  const wrap  = document.getElementById('fetch-progress-wrap');
  const fill  = document.getElementById('fetch-progress-fill');
  const label = document.getElementById('fetch-progress-label');
  const statusText = document.getElementById('fetch-status-text');

  btn.disabled = true;
  wrap.classList.remove('hidden');
  fill.classList.add('indeterminate');
  label.textContent = 'Starting…';
  statusText.textContent = '';

  try {
    await chrome.runtime.sendMessage({ action: 'fetch_missing' });
  } catch (e) {
    label.textContent = `Error: ${e.message}`;
    fill.classList.remove('indeterminate');
    btn.disabled = false;
  }
}

async function cancelFetch() {
  await chrome.runtime.sendMessage({ action: 'cancel_fetch_missing' }).catch(() => {});
}

function onMessage(msg) {
  const fill  = document.getElementById('fetch-progress-fill');
  const label = document.getElementById('fetch-progress-label');
  const wrap  = document.getElementById('fetch-progress-wrap');
  const btn   = document.getElementById('btn-fetch-now');
  const statusText = document.getElementById('fetch-status-text');

  switch (msg.type) {
    case 'fetch_missing_progress': {
      fill.classList.remove('indeterminate');
      fill.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
      label.textContent = `${msg.done} / ${msg.total} — ${msg.current || ''}`;
      break;
    }
    case 'fetch_missing_done': {
      fill.classList.remove('indeterminate');
      fill.style.width = '100%';
      label.textContent = msg.skipped > 0
        ? `Done — ${msg.fetched} fetched, ${msg.skipped} already complete`
        : `Done — all ${msg.fetched} tab${msg.fetched !== 1 ? 's' : ''} updated`;
      statusText.textContent = '';
      btn.disabled = false;
      // Auto-hide progress after a moment
      setTimeout(() => {
        wrap.classList.add('hidden');
        fill.style.width = '0%';
        statusText.textContent = 'Scans all shelved tabs and fetches any missing page text and, if focus switching is enabled above, missing thumbnails too.';
      }, 3500);
      break;
    }
    case 'fetch_missing_cancelled': {
      fill.classList.remove('indeterminate');
      label.textContent = `Cancelled after ${msg.done} tab${msg.done !== 1 ? 's' : ''}`;
      btn.disabled = false;
      break;
    }
    case 'fetch_missing_error': {
      fill.classList.remove('indeterminate');
      fill.style.background = '#ef4444';
      label.textContent = `Error: ${msg.message}`;
      btn.disabled = false;
      break;
    }
  }
}

// ─── Storage usage ────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function loadStorageUsage() {
  // Local storage: chrome.storage.local has no quota API, use QUOTA_BYTES constant
  // unlimitedStorage permission means no enforced quota, but we still estimate usage
  const LOCAL_QUOTA = chrome.storage.local.QUOTA_BYTES ?? (5 * 1024 * 1024); // 5 MB default
  chrome.storage.local.getBytesInUse(null, localUsed => {
    const pct = Math.min(100, (localUsed / LOCAL_QUOTA) * 100);
    document.getElementById('local-storage-fill').style.width = `${pct}%`;
    document.getElementById('local-storage-label').textContent =
      `${formatBytes(localUsed)} / ${formatBytes(LOCAL_QUOTA)}`;
  });

  // Sync storage: hard quota is 102,400 bytes
  const SYNC_QUOTA = chrome.storage.sync.QUOTA_BYTES;
  chrome.storage.sync.getBytesInUse(null, syncUsed => {
    const pct = Math.min(100, (syncUsed / SYNC_QUOTA) * 100);
    document.getElementById('sync-storage-fill').style.width = `${pct}%`;
    document.getElementById('sync-storage-fill').style.background =
      pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '';
    document.getElementById('sync-storage-label').textContent =
      `${formatBytes(syncUsed)} / ${formatBytes(SYNC_QUOTA)}`;
  });
}

async function clearStorage(action, message) {
  if (!confirm(message)) return;
  const btns = ['btn-clear-thumbnails', 'btn-clear-content', 'btn-clear-both'];
  btns.forEach(id => { document.getElementById(id).disabled = true; });
  try {
    await chrome.runtime.sendMessage({ action });
  } finally {
    btns.forEach(id => { document.getElementById(id).disabled = false; });
    loadStorageUsage();
  }
}

// applyTheme() and applyThemeFromMode() are imported from ../lib/theme.js
