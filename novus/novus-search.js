/* NOVUS — global lead search (⌘K / Ctrl+K) — shared by every /novus page.
 *
 * A command palette over ONE server operation, ?novus_operation=lead-search
 * (lib/lead-search.mjs): agency, contact, phone (any written form), email,
 * domain, town, property address, enquiry text, lead id. Phone matching is
 * the same code the incoming-callback overlay uses, so what ⌘K finds for a
 * pasted number is exactly what a callback from that number resolves to.
 *
 * Two modes:
 *   navigate  (default) — Enter/click opens the lead in the calling interface
 *                         (/novus/calling.html?lead=<agency_id>). calling.html
 *                         sets NovusSearch.navigate to open it in place instead.
 *   pick                — resolves a Promise with the chosen lead and closes.
 *                         Used by the unknown-caller "Search leads" button and
 *                         the "Link to lead" action on the call screen.
 *
 * Owns nothing else: no NOVUS state, no writes. Portaled to <body>.
 */
(function () {
  var OP = '/api/novus/personalisation?novus_operation=lead-search';
  var DEBOUNCE_MS = 90;
  var CACHE_TTL_MS = 30000;
  var cache = new Map();
  var root = null, input = null, list = null, foot = null, modeEl = null, hintEl = null;
  var state = { open: false, mode: 'navigate', results: [], active: 0, seq: 0, resolve: null, controller: null, timer: null, query: '' };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isMac() { return /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac OS/.test(navigator.userAgent || ''); }

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'gs';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Search leads');
    root.innerHTML =
      '<div class="gs-box">' +
        '<div class="gs-head">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
          '<span class="gs-mode" data-gs-mode hidden></span>' +
          '<input class="gs-in" data-gs-input type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Search leads, agencies, numbers, properties…" />' +
          '<span class="gs-hint" data-gs-hint>esc</span>' +
        '</div>' +
        '<div class="gs-list" data-gs-list role="listbox"></div>' +
        '<div class="gs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> <span data-gs-enter>open</span></span><span><kbd>esc</kbd> close</span><span class="gs-took" data-gs-took></span></div>' +
      '</div>';
    document.body.appendChild(root);
    input = root.querySelector('[data-gs-input]');
    list = root.querySelector('[data-gs-list]');
    foot = root.querySelector('[data-gs-took]');
    modeEl = root.querySelector('[data-gs-mode]');
    hintEl = root.querySelector('[data-gs-hint]');
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(null); });
    input.addEventListener('input', function () { schedule(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); choose(state.active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    list.addEventListener('click', function (e) {
      var row = e.target.closest('[data-gs-row]');
      if (row) choose(Number(row.getAttribute('data-gs-row')));
    });
    list.addEventListener('mousemove', function (e) {
      var row = e.target.closest('[data-gs-row]');
      if (row && Number(row.getAttribute('data-gs-row')) !== state.active) { state.active = Number(row.getAttribute('data-gs-row')); paintActive(); }
    });
  }

  function schedule(q) {
    if (state.timer) clearTimeout(state.timer);
    state.query = q;
    if (!String(q).trim()) { state.results = []; render({ empty: true }); return; }
    state.timer = setTimeout(function () { run(q); }, DEBOUNCE_MS);
  }

  function run(q) {
    var key = String(q).trim().toLowerCase();
    var hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) { state.results = hit.results; state.active = 0; render({ took: hit.took, cached: true }); return; }
    if (state.controller) state.controller.abort();
    var controller = new AbortController();
    state.controller = controller;
    var seq = ++state.seq;
    render({ loading: true });
    fetch(OP + '&q=' + encodeURIComponent(q) + '&limit=14', { headers: { Accept: 'application/json' }, signal: controller.signal })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (seq !== state.seq) return;
        if (!data || data.success === false) throw new Error((data && data.error) || 'Search failed');
        cache.set(key, { at: Date.now(), results: data.results || [], took: data.took_ms });
        state.results = data.results || []; state.active = 0;
        render({ took: data.took_ms });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (seq !== state.seq) return;
        state.results = [];
        render({ error: (err && err.message) || 'Search failed' });
      });
  }

  function activityLine(r) {
    var a = r.last_activity && r.last_activity.label;
    if (a) return a;
    if (r.pipeline_status) return String(r.pipeline_status).replace(/_/g, ' ').toLowerCase();
    return 'No activity yet';
  }

  function rowHtml(r, i) {
    var who = [r.contact_name, r.contact_role].filter(Boolean);
    var line2 = who.length ? '<b>' + esc(who.join(' · ')) + '</b>' : '<span>No named contact</span>';
    var bits = [];
    if (r.matched_number || r.phone) bits.push('<span class="mono">' + esc(r.matched_number || r.phone) + '</span>');
    if (r.property) bits.push(esc(r.property));
    if (r.location) bits.push(esc(r.location));
    return '<button class="gs-row' + (i === state.active ? ' on' : '') + '" type="button" role="option" data-gs-row="' + i + '" aria-selected="' + (i === state.active) + '">' +
      '<div class="gs-t">' + esc(r.agency_name || '(no agency name)') + '</div>' +
      '<div class="gs-r">' + esc(activityLine(r)) + (r.callback_expected ? '<br><span class="pill t-amber bare">callback expected</span>' : '') + '</div>' +
      '<div class="gs-s">' + line2 + (bits.length ? ' &nbsp;·&nbsp; ' + bits.join(' &nbsp;·&nbsp; ') : '') + '</div>' +
    '</button>';
  }

  function render(opts) {
    opts = opts || {};
    if (opts.loading) { if (!list.children.length || list.querySelector('.gs-empty')) list.innerHTML = '<div class="gs-empty">Searching…</div>'; foot.textContent = ''; return; }
    if (opts.empty) { list.innerHTML = '<div class="gs-empty"><b>Search every lead</b>Agency, contact, phone in any format, email, town, property address or enquiry text.</div>'; foot.textContent = ''; return; }
    if (opts.error) { list.innerHTML = '<div class="gs-empty"><b>Search unavailable</b>' + esc(opts.error) + '</div>'; foot.textContent = ''; return; }
    if (!state.results.length) { list.innerHTML = '<div class="gs-empty"><b>No matching lead</b>Nothing holds “' + esc(state.query) + '”. Try part of the agency name, the town, or the number without spaces.</div>'; }
    else list.innerHTML = state.results.map(rowHtml).join('');
    foot.textContent = opts.took != null ? (state.results.length + ' result' + (state.results.length === 1 ? '' : 's') + ' · ' + opts.took + 'ms' + (opts.cached ? ' (cached)' : '')) : '';
  }

  function paintActive() {
    var rows = list.querySelectorAll('[data-gs-row]');
    Array.prototype.forEach.call(rows, function (el) {
      var on = Number(el.getAttribute('data-gs-row')) === state.active;
      el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on));
    });
  }
  function move(delta) {
    if (!state.results.length) return;
    state.active = (state.active + delta + state.results.length) % state.results.length;
    paintActive();
    var el = list.querySelector('[data-gs-row="' + state.active + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    var r = state.results[i];
    if (!r) return;
    if (state.mode === 'pick') { close(r); return; }
    close(null);
    if (typeof NovusSearch.navigate === 'function') { NovusSearch.navigate(r); return; }
    window.location.href = '/novus/calling.html?lead=' + encodeURIComponent(r.agency_id);
  }

  function open(opts) {
    opts = opts || {};
    ensureDom();
    if (state.open) close(null);
    state.open = true; state.mode = opts.mode === 'pick' ? 'pick' : 'navigate'; state.results = []; state.active = 0;
    modeEl.hidden = !opts.title; modeEl.textContent = opts.title || '';
    root.querySelector('[data-gs-enter]').textContent = state.mode === 'pick' ? 'choose' : 'open';
    input.placeholder = opts.placeholder || 'Search leads, agencies, numbers, properties…';
    input.value = opts.query || '';
    root.classList.add('on');
    render({ empty: !input.value });
    if (input.value) run(input.value);
    setTimeout(function () { input.focus(); input.select(); }, 0);
    return new Promise(function (resolve) { state.resolve = resolve; });
  }

  function close(result) {
    if (!root) return;
    root.classList.remove('on');
    state.open = false;
    if (state.controller) { state.controller.abort(); state.controller = null; }
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    var resolve = state.resolve; state.resolve = null;
    if (resolve) resolve(result || null);
  }

  function wireControls() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-global-search]'), function (btn) {
      if (btn.getAttribute('data-gs-wired')) return;
      btn.setAttribute('data-gs-wired', '1');
      btn.addEventListener('click', function () { open(); });
      var kbd = btn.querySelector('kbd');
      if (kbd) kbd.textContent = isMac() ? '⌘K' : 'Ctrl K';
    });
  }

  document.addEventListener('keydown', function (e) {
    var mod = isMac() ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (state.open && state.mode === 'navigate') { close(null); return; }
      if (!state.open) open();
    }
  });

  var NovusSearch = {
    open: open,
    close: function () { close(null); },
    pick: function (opts) { return open(Object.assign({}, opts || {}, { mode: 'pick' })); },
    navigate: null,
    isOpen: function () { return state.open; },
  };
  window.NovusSearch = NovusSearch;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireControls); else wireControls();
})();
