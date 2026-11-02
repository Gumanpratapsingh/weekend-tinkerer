// Light, dark, or following the device (Settings -> Appearance). Runs before the page paints so it never flashes the wrong theme.
(function () {
  var root = document.documentElement, mq = window.matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    var pick = null;
    try { pick = localStorage.getItem('cb_theme'); } catch (e) { /* private mode: follow the device */ }
    var theme = pick === 'light' || pick === 'dark' ? pick : mq.matches ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) { m.removeAttribute('media'); m.content = theme === 'dark' ? '#000000' : '#ffffff'; });
  }
  apply();
  mq.addEventListener('change', apply);
  window.cbApplyTheme = apply;
})();
