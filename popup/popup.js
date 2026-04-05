'use strict';

// ─── Elements ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const btnArchiveCurrent     = $('btn-archive-current');
const btnArchiveAll         = $('btn-archive-all');
const btnArchiveCloseCurrent= $('btn-archive-close-current');
const btnArchiveCloseAll    = $('btn-archive-close-all');
const btnBrand              = $('btn-brand');
const btnSettings           = $('btn-settings');

const statusEl              = $('status');
const statusFill            = $('status-fill');
const statusText            = $('status-text');

const confirmOverlay        = $('confirm-overlay');
const confirmMessage        = $('confirm-message');
const confirmCancel         = $('confirm-cancel');
const confirmOk             = $('confirm-ok');

// ─── State ────────────────────────────────────────────────────────────────────

let busy = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  btnArchiveCurrent.addEventListener('click', () => doAction('archive_current'));
  btnArchiveAll.addEventListener('click', () => confirmArchiveAll(() => doAction('archive_all')));
  btnArchiveCloseCurrent.addEventListener('click', () =>
    confirm('Shelve and close the current tab?', () => doAction('archive_close_current'))
  );
  btnArchiveCloseAll.addEventListener('click', () =>
    confirmArchiveAll(() => doAction('archive_close_all'), true)
  );
  btnBrand.addEventListener('click', openArchive);
  btnSettings.addEventListener('click', openSettings);

  chrome.runtime.onMessage.addListener(onMessage);
});

async function confirmArchiveAll(onOk, andClose = false) {
  const settings = await chrome.storage.local.get('shelve_settings');
  const switchFocus = !!settings.shelve_settings?.switchFocus;
  const closeNote = andClose ? ' and close them' : '';
  const focusNote = switchFocus
    ? 'Focus will switch to each tab automatically during the process.'
    : 'Thumbnails may not be captured correctly — enable "Switch Focus" in settings for best results.';
  confirm(`Shelve all open tabs${closeNote}?\n\n${focusNote}`, onOk);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function doAction(action) {
  if (busy) return;
  setAllDisabled(true);
  showStatus('indeterminate', 'Working…');

  try {
    const resp = await chrome.runtime.sendMessage({ action });
    if (resp?.error) throw new Error(resp.error);
    const count = resp?.count;
    showStatus(100, count ? `Done — ${count} tab${count !== 1 ? 's' : ''} shelved` : 'Done!');
    setTimeout(resetStatus, 2000);
  } catch (e) {
    showStatus(0, `Error: ${e.message}`);
    statusFill.style.background = '#ef4444';
    setTimeout(resetStatus, 3000);
  } finally {
    setAllDisabled(false);
    busy = false;
  }
}

async function openArchive() {
  await chrome.runtime.sendMessage({ action: 'open_archive' });
  window.close();
}

async function openSettings() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
  window.close();
}

// ─── Progress from service worker ────────────────────────────────────────────

function onMessage(msg) {
  switch (msg.type) {
    case 'archive_start':
      showStatus('indeterminate', `Shelving: ${msg.title || msg.url}…`);
      break;
    case 'archive_batch_progress':
      showStatus((msg.done / msg.total) * 100, `Shelved ${msg.done} / ${msg.total}…`);
      break;
    case 'archive_batch_done':
      showStatus(100, `All ${msg.total} tabs shelved!`);
      setTimeout(resetStatus, 2000);
      break;
    case 'archive_error':
      showStatus(0, `Error: ${msg.message}`);
      statusFill.style.background = '#ef4444';
      setTimeout(resetStatus, 3000);
      break;
  }
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function showStatus(progressOrMode, text) {
  statusEl.classList.remove('hidden');
  statusText.textContent = text;
  statusFill.style.background = 'var(--accent)';

  if (progressOrMode === 'indeterminate') {
    statusFill.classList.add('indeterminate');
    statusFill.style.width = '';
  } else {
    statusFill.classList.remove('indeterminate');
    statusFill.style.width = `${progressOrMode}%`;
  }
}

function resetStatus() {
  busy = false;
  statusEl.classList.add('hidden');
  statusFill.classList.remove('indeterminate');
  statusFill.style.width = '0%';
  setAllDisabled(false);
}

function setAllDisabled(state) {
  busy = state;
  [btnArchiveCurrent, btnArchiveAll, btnArchiveCloseCurrent, btnArchiveCloseAll].forEach(b => {
    b.disabled = state;
  });
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

function confirm(message, onOk) {
  confirmMessage.textContent = message;
  confirmOverlay.classList.remove('hidden');

  const cleanup = () => {
    confirmOverlay.classList.add('hidden');
    confirmOk.removeEventListener('click', handleOk);
    confirmCancel.removeEventListener('click', handleCancel);
  };

  const handleOk = () => { cleanup(); onOk(); };
  const handleCancel = () => cleanup();

  confirmOk.addEventListener('click', handleOk);
  confirmCancel.addEventListener('click', handleCancel);
}
