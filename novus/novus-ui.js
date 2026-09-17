/* NOVUS Command Centre — shared shell behaviour.
 *
 * Theme behaviour lives here, plus tiny page-specific presentation hooks that
 * do not read or write backend state.
 *
 * The theme is applied by a tiny inline snippet in each page's <head> BEFORE
 * first paint (see `data-theme-boot`), so there is no light/dark flash. This
 * file only handles the toggle, the chrome metadata, cross-tab sync, and the
 * calling-page gatekeeper context panel.
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

  function installCallingGatekeeperContext() {
    if (!/\/novus\/calling(?:\.html)?$/.test(window.location.pathname)) return;
    if (typeof gatekeeperScreenHtml !== 'function') return;

    var originalGatekeeperScreenHtml = gatekeeperScreenHtml;
    var dateFormatter = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });

    function safe(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatProbeSentAt(value) {
      var ms = Date.parse(String(value || ''));
      return Number.isFinite(ms) ? dateFormatter.format(new Date(ms)) : '';
    }

    gatekeeperScreenHtml = function () {
      var html = originalGatekeeperScreenHtml();
      var lead = (typeof CALL !== 'undefined' && CALL && CALL.lead) ? CALL.lead : null;
      if (!lead) return html;

      var ctx = lead.context || {};
      var property = String(ctx.property || '').trim();
      var sentAt = formatProbeSentAt(lead.probe_sent_at);
      if (!property && !sentAt) return html;

      var context = '<div class="banner" style="margin-bottom:20px">'
        + '<div style="font-weight:700;margin-bottom:5px">Probe enquiry</div>'
        + '<div><b>Property:</b> ' + safe(property || 'Not recorded') + '</div>'
        + '<div><b>Enquiry sent:</b> ' + safe(sentAt || 'Not recorded') + '</div>'
        + '</div>';

      return html.replace(
        '<div class="cm-label">Gatekeeper script</div>',
        context + '<div class="cm-label">Gatekeeper script</div>'
      );
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // calling.html declares its renderer during parsing; this deferred shared
  // script runs afterwards, so the wrapper can add probe context without
  // changing any call-state or outcome logic.
  installCallingGatekeeperContext();

  // Another Command Centre tab switched theme — follow it, so the console is
  // one product across every open page.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue);
  });
})();
