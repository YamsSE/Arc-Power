// Pre-CSS theme bootstrap. Keep this deliberately self-contained: it runs
// before stylesheets under the renderer CSP and owns no persistence or IPC.
(() => {
  const THEMES = ['dark', 'midnight', 'light', 'red', 'yellow'];
  const value = new URLSearchParams(window.location.search).get('theme');
  document.documentElement.dataset.theme = THEMES.includes(value) ? value : 'dark';
})();
