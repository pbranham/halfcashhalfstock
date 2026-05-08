// Applied synchronously in <head> before the page paints to avoid theme flash.
// Reads any persisted theme preference from localStorage and sets the
// data-theme attribute on <html>; absence of the attribute lets the
// prefers-color-scheme media query in style.css drive the theme.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (_e) {
    /* localStorage unavailable (private mode, etc.) — fall through to OS preference */
  }
})();
