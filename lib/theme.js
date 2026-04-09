/**
 * Shared theme utilities — used by archive and settings pages.
 */

export function applyThemeFromMode(mode) {
  const html = document.documentElement;
  let theme;
  if (mode === 'dark') {
    theme = 'dark';
  } else if (mode === 'light') {
    theme = 'light';
  } else {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    theme = mq.matches ? 'dark' : 'light';
    mq.onchange = e => {
      const next = e.matches ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      localStorage.setItem('shelve_theme', next);
    };
  }
  html.setAttribute('data-theme', theme);
  localStorage.setItem('shelve_theme', theme);
}

export async function applyTheme() {
  const res = await chrome.storage.local.get('shelve_settings');
  const mode = res.shelve_settings?.darkMode || 'system';
  applyThemeFromMode(mode);
}
