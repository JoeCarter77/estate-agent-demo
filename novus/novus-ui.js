/* NOVUS Command Centre — shared shell behaviour.
 *
 * Theme behaviour lives here, plus tiny page-specific presentation hooks that
 * do not mutate NOVUS backend state.
 *
 * The theme is applied by a tiny inline snippet in each page's <head> BEFORE
 * first paint (see `data-theme-boot`), so there is no light/dark flash.
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

  function installCallingContext() {
    if (!/\/novus\/calling(?:\.html)?$/.test(window.location.pathname)) return;
    if (typeof renderModeHead !== 'function') return;

    var cache = Object.create(null);
    var originalRenderModeHead = renderModeHead;
    var dateFormatter = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/London'
    });
    var sellerLabels = {
      none: 'Not mentioned',
      asked_position: 'Asked about your sale',
      acknowledged: 'Acknowledged',
      valuation_offered: 'Valuation offered',
      valuation_booked: 'Valuation booked'
    };

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

    function roleLabel(lead) {
      var role = String(lead && lead.contact_role || '').trim();
      if (role) return role;
      var tier = String(lead && lead.decision_maker_tier || '').trim();
      if (tier === 'NAMED_OWNER') return 'Owner';
      if (tier === 'NAMED_SENIOR_DECISION_MAKER') return 'Senior decision-maker';
      if (tier === 'NAMED_CONTACT') return 'Role unknown';
      return 'Unknown';
    }

    function field(label, value, emphasis) {
      return '<div style="min-width:150px;flex:1 1 170px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);">'
        + '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:3px">' + safe(label) + '</div>'
        + '<div style="font-size:13px;font-weight:' + (emphasis ? '700' : '600') + ';line-height:1.35">' + safe(value || 'Unknown') + '</div>'
        + '</div>';
    }

    function sellerLabel(data) {
      if (!data) return 'Loading…';
      var raw = String(data.seller_recognition || '').trim().toLowerCase();
      return raw ? (sellerLabels[raw] || raw.replace(/_/g, ' ')) : 'Not assessed yet';
    }

    function followupLabel(data) {
      if (!data) return 'Loading…';
      if (data.contact_attempts == null) return 'Not recorded';
      var n = Number(data.contact_attempts) || 0;
      var out = n + ' contact attempt' + (n === 1 ? '' : 's');
      var channels = String(data.channels_used || '').trim();
      if (channels) out += ' · ' + channels.replace(/\s*,\s*/g, ' / ');
      return out;
    }

    function ensureContext(lead) {
      var agencyId = String(lead && lead.agency_id || '').trim();
      if (!agencyId || cache[agencyId]) return;
      cache[agencyId] = { status: 'loading', data: null };
      fetch('/api/lead?call_context=1&agency_id=' + encodeURIComponent(agencyId), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Context request failed');
          return res.json();
        })
        .then(function (body) {
          cache[agencyId] = { status: 'done', data: body.call_context || {} };
        })
        .catch(function () {
          cache[agencyId] = { status: 'error', data: null };
        })
        .finally(function () {
          try {
            if (typeof CALL !== 'undefined' && CALL && CALL.lead && String(CALL.lead.agency_id || '') === agencyId) renderCallingContext();
          } catch (e) { /* call ended while the request was in flight */ }
        });
    }

    function renderCallingContext() {
      var existing = document.getElementById('cm-probe-context');
      var lead = (typeof CALL !== 'undefined' && CALL && CALL.lead) ? CALL.lead : null;
      if (!lead) {
        if (existing) existing.remove();
        return;
      }

      ensureContext(lead);
      var state = cache[String(lead.agency_id || '').trim()] || { status: 'loading', data: null };
      var data = state.data;
      var base = lead.context || {};
      var property = String((data && data.property) || base.property || '').trim() || 'Not recorded';
      var sentAt = formatProbeSentAt((data && data.probe_sent_at) || lead.probe_sent_at) || 'Not recorded';
      var contactName = String(lead.contact_name || 'Unknown contact').trim();
      var contact = contactName + ' · ' + roleLabel(lead);
      var seller = state.status === 'error' ? 'Unavailable' : sellerLabel(data);
      var followup = state.status === 'error' ? 'Unavailable' : followupLabel(data);

      var html = '<div id="cm-probe-context" style="padding:10px 18px;border-bottom:1px solid var(--line);background:var(--bg);">'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">'
        + field('Property', property, true)
        + field('Seller signal', seller, seller === 'Not mentioned')
        + field('Follow-up', followup, false)
        + field('Contact', contact, true)
        + field('Enquiry sent', sentAt, false)
        + '</div></div>';

      if (existing) existing.outerHTML = html;
      else {
        var head = document.querySelector('#cm .cm-head');
        if (head) head.insertAdjacentHTML('afterend', html);
      }
    }

    renderModeHead = function () {
      originalRenderModeHead();
      renderCallingContext();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // calling.html declares its renderer during parsing; this deferred shared
  // script runs afterwards and adds read-only context around it.
  installCallingContext();

  // Another Command Centre tab switched theme — follow it, so the console is
  // one product across every open page.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue);
  });
})();
