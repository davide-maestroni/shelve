(function () {
  const m = localStorage.getItem('shelve_theme');
  if (m === 'dark' || m === 'light') document.documentElement.setAttribute('data-theme', m);
})();
