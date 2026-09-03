/* NOVUS Command Centre — shared shell behaviour.
 *
 * Theme only. This file deliberately owns nothing else: every page's own
 * <script> keeps its own data logic, and nothing here reads or writes NOVUS
 * state.
 *
 * The theme is applied by a tiny inline snippet in each page's <head> BEFORE
 * first paint (see `data-theme-boot`), so there is no light/dark flash. This
 * file only handles the toggle, the chrome metadata and cross-tab sync.
 */
(function () {
  var KEY = 'novus.theme';

  function current() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var light = theme === 'light';
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', light ? '#F5F2EC' : '#0A0B0E');
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', theme);
    var label = light ? 'Switch to dark theme' : 'Switch to light theme';
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (btn) {
      btn.setAttribute('aria-pressed', String(light));
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
    });
  }

  function toggle() {
    var next = current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode — session only */ }
    apply(next);
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (btn) {
      if (btn.getAttribute('data-theme-wired')) return;
      btn.setAttribute('data-theme-wired', '1');
      btn.addEventListener('click', toggle);
    });
    apply(current());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // Another Command Centre tab switched theme — follow it, so the console is
  // one product across every open page.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue);
  });
})();
