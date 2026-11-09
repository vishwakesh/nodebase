/* Same-origin, CSP-compatible theme bootstrap. Applies before the app mounts. */
(() => {
  try {
    const preference = localStorage.getItem('nodebase-theme') || 'system';
    const dark = preference === 'dark' || (
      preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches
    );
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePreference = preference;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0B0F0C' : '#F6F8F3';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
