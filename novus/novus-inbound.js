/* NOVUS — browser voice Device + incoming-callback overlay — shared by every
 * /novus page (loaded after the vendored Twilio Voice SDK and novus-search.js).
 *
 * ONE DEVICE PER PAGE. This module owns the Twilio.Device (identity
 * novus-operator, token from ?novus_operation=twilio-token) and registers it
 * for incoming calls. calling.html does not build its own any more — it asks
 * NovusVoice.ready() for this one and dials through it exactly as before.
 *
 * THE REAL-TIME CHANNEL IS THE SDK. voice-inbound.js answers a call on the
 * NOVUS number with <Dial><Client>novus-operator</Client></Dial> (see
 * lib/calling-inbound.mjs), so Twilio delivers the ring straight to this
 * page as the Device's `incoming` event — sub-second, no polling. The call_id
 * of the CALLS row opened for it rides along as a custom parameter; the
 * overlay reads GET calling-inbound&call_id for the matched lead(s).
 *
 * WHO ANSWERS. Only calling.html can put the call on its Calling Mode screen,
 * so it installs NovusVoice.answerHandler. Anywhere else, Answer means
 * HANDOFF: flag intent=handoff (with the chosen lead), reject this ring so
 * Twilio's Dial action rings again, and go to /novus/calling.html?inbound=…
 * where the calling page auto-answers the re-ring. Decline means voicemail.
 *
 * NEVER OVER A LIVE CALL. While a Twilio call is up the SDK itself refuses a
 * second incoming (allowIncomingWhileBusy=false → busy → voicemail). A
 * manual-mode call or a half-logged outcome is reported by the page through
 * NovusVoice.isBusy(); then the callback is declined to voicemail and only a
 * small toast says who it was.
 */
(function () {
  var OP = function (name) { return '/api/novus/personalisation?novus_operation=' + name; };
  var TOKEN_URL = OP('twilio-token');
  var INBOUND_URL = OP('calling-inbound');
  var INTENT_URL = OP('calling-inbound-intent');
  var IDENTITY_NOTE = 'novus-operator';

  var device = null;
  var readyPromise = null;
  var readyState = { enabled: false, reason: '', device: null, caller_id: '' };
  var overlay = null, toasts = null;
  var ring = null; // { call, call_id, from, info, selection, closed }

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function logErr(label, e) { console.warn('[novus-voice] ' + label, { code: e && e.code, name: e && e.name, message: e && e.message }); }
  function relative(iso) {
    var ms = Date.now() - Date.parse(iso || ''); if (!isFinite(ms)) return '';
    var m = Math.round(ms / 60000); if (m < 2) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + 'h ago'; if (h < 48) return 'yesterday'; return Math.round(h / 24) + 'd ago';
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || d.success === false) throw new Error(d.error || ('Request failed (' + r.status + ')')); return d; }); });
  }
  function fetchToken() {
    return fetch(TOKEN_URL, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.success === false) throw new Error((d && d.error) || 'Token request failed');
      return d;
    });
  }

  // ── the Device ─────────────────────────────────────────────────────────
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = fetchToken().then(function (data) {
      if (!data.enabled) { readyState = { enabled: false, reason: 'Browser calling not configured — missing ' + (data.missing || []).join(', '), device: null, caller_id: '' }; return readyState; }
      if (!window.Twilio || !window.Twilio.Device) { readyState = { enabled: false, reason: 'Twilio Voice SDK failed to load', device: null, caller_id: '' }; return readyState; }
      device = new Twilio.Device(data.token, {
        codecPreferences: ['opus', 'pcmu'], closeProtection: true, logLevel: 'error',
        enableImprovedSignalingErrorPrecision: true,
        allowIncomingWhileBusy: false,
      });
      device.on('registered', function () { console.debug('[novus-voice] registered as ' + IDENTITY_NOTE); });
      device.on('unregistered', function () { console.debug('[novus-voice] unregistered'); });
      device.on('tokenWillExpire', function () {
        fetchToken().then(function (t) { if (t.enabled) device.updateToken(t.token); }).catch(function (e) { logErr('token refresh failed', e); });
      });
      device.on('error', function (e) { logErr('device error', e); });
      device.on('incoming', onIncoming);
      // Registration is what makes Twilio ring THIS page. Failure is not
      // fatal for outbound dialling, so it only logs.
      device.register().catch(function (e) { logErr('register() failed — callbacks will not ring this page', e); });
      readyState = { enabled: true, reason: '', device: device, caller_id: data.caller_id || '', expires_at: data.expires_at || '' };
      return readyState;
    }).catch(function (err) {
      readyState = { enabled: false, reason: 'Browser calling unavailable: ' + (err && err.message || err), device: null, caller_id: '' };
      return readyState;
    });
    return readyPromise;
  }

  // ── incoming ───────────────────────────────────────────────────────────
  function paramOf(call, key) {
    try {
      var cp = call.customParameters;
      if (cp && typeof cp.get === 'function') return cp.get(key) || '';
      if (cp && cp[key]) return cp[key];
    } catch (e) { /* ignore */ }
    return '';
  }

  function onIncoming(call) {
    var callId = paramOf(call, 'call_id');
    var from = paramOf(call, 'from') || (call.parameters && call.parameters.From) || '';
    console.debug('[novus-voice] incoming', { call_id: callId, from: from });
    // The calling page may take this ring itself (an auto-answer after a
    // handoff, or its own Calling Mode is open and idle).
    if (typeof NovusVoice.onIncoming === 'function' && NovusVoice.onIncoming(call, { call_id: callId, from: from }) === true) return;
    if (typeof NovusVoice.isBusy === 'function' && NovusVoice.isBusy()) {
      // Never disrupt an active call: the caller goes to voicemail; Joe sees who it was.
      var r = { call: call, call_id: callId, from: from, closed: true };
      decline(r, 'busy').then(function () { return loadInfo(callId); }).then(function (info) {
        var who = info && info.candidates && info.candidates[0];
        toast('Missed callback — ' + (who ? (who.contact_name || who.agency_name) : (info && info.caller && info.caller.display) || from), 'You were on a call. They were sent to voicemail.');
      }).catch(function () { toast('Missed callback', 'You were on a call. The caller was sent to voicemail.'); });
      return;
    }
    if (ring && !ring.closed) { try { call.reject(); } catch (e) { /* ignore */ } return; }
    ring = { call: call, call_id: callId, from: from, info: null, selection: null, closed: false };
    call.on('cancel', function () { endRing('cancel'); });
    call.on('disconnect', function () { endRing('disconnect'); });
    call.on('reject', function () { if (ring && ring.call === call && !ring.closed) closeOverlay(); });
    call.on('error', function (e) { logErr('incoming call error', e); endRing('error'); });
    showOverlay();
    loadInfo(callId).then(function (info) {
      if (!ring || ring.call !== call || ring.closed) return;
      ring.info = info;
      var pre = (info.candidates || []).find(function (c) { return c.preselected; }) || ((info.candidates || []).length === 1 ? info.candidates[0] : null);
      ring.selection = pre || null;
      renderOverlay();
    }).catch(function (err) {
      if (!ring || ring.call !== call || ring.closed) return;
      ring.info = { error: err.message, candidates: [], caller: { display: from } };
      renderOverlay();
    });
  }

  function loadInfo(callId) {
    if (!callId) return Promise.reject(new Error('no call reference on this ring'));
    return fetch(INBOUND_URL + '&call_id=' + encodeURIComponent(callId), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d || d.success === false) throw new Error((d && d.error) || 'Could not read the incoming call'); return d; });
  }

  function endRing(why) {
    if (!ring || ring.closed) return;
    var r = ring;
    var who = r.selection || (r.info && r.info.candidates && r.info.candidates[0]);
    var name = who ? (who.contact_name || who.agency_name) : ((r.info && r.info.caller && r.info.caller.display) || r.from);
    closeOverlay();
    if (why === 'cancel') toast('Missed callback — ' + name, 'They hung up before you answered.');
  }

  function decline(r, reason) {
    r.closed = true;
    var p = r.call_id ? postJson(INTENT_URL, { confirm: 'INBOUND_CALL', call_id: r.call_id, intent: 'decline', reason: reason || '' }).catch(function (e) { logErr('decline intent failed', e); }) : Promise.resolve();
    return p.then(function () { try { r.call.reject(); } catch (e) { /* ignore */ } });
  }

  function selectionPayload(sel) {
    if (!sel) return {};
    return { agency_id: sel.agency_id || '', contact_name: sel.contact_name || '', contact_role: sel.contact_role || '' };
  }

  function answer() {
    if (!ring || ring.closed) return;
    var r = ring;
    var btn = overlay.querySelector('[data-inc-answer]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Answering'; }
    if (typeof NovusVoice.answerHandler === 'function') {
      r.closed = true;
      closeOverlay();
      try { NovusVoice.answerHandler(r.call, r.info || { candidates: [], caller: { display: r.from, e164: r.from } }, r.selection); }
      catch (e) { logErr('answer handler failed', e); }
      return;
    }
    // Handoff to the calling page: flag → reject this ring → Twilio re-rings
    // → calling.html?inbound=… answers it.
    r.closed = true;
    postJson(INTENT_URL, Object.assign({ confirm: 'INBOUND_CALL', call_id: r.call_id, intent: 'handoff' }, selectionPayload(r.selection)))
      .catch(function (e) { logErr('handoff intent failed (continuing — the calling page will still answer a re-ring)', e); })
      .then(function () {
        try { r.call.reject(); } catch (e) { /* ignore */ }
        try { if (device) device.destroy(); } catch (e) { /* ignore */ }
        window.location.href = '/novus/calling.html?inbound=' + encodeURIComponent(r.call_id) + (r.selection && r.selection.agency_id ? '&lead=' + encodeURIComponent(r.selection.agency_id) : '');
      });
  }

  function searchForCaller() {
    if (!ring || ring.closed || !window.NovusSearch) return;
    var r = ring;
    NovusSearch.pick({ title: 'Who is calling?', query: (r.info && r.info.caller && r.info.caller.display) || '' }).then(function (lead) {
      if (!lead || !ring || ring !== r || r.closed) return;
      r.selection = lead;
      r.info = r.info || { candidates: [], caller: { display: r.from } };
      if (!(r.info.candidates || []).some(function (c) { return c.agency_id === lead.agency_id; })) r.info.candidates = [Object.assign({ reasons: ['Chosen from search'] }, lead)].concat(r.info.candidates || []);
      renderOverlay();
    });
  }

  // ── overlay ────────────────────────────────────────────────────────────
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'inc';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Incoming call');
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-inc-answer]')) { answer(); return; }
      if (t.closest('[data-inc-decline]')) { if (ring && !ring.closed) { var r = ring; decline(r, 'declined'); closeOverlay(); } return; }
      if (t.closest('[data-inc-search]')) { searchForCaller(); return; }
      var cand = t.closest('[data-inc-cand]');
      if (cand && ring && ring.info) {
        var id = cand.getAttribute('data-inc-cand');
        ring.selection = (ring.info.candidates || []).find(function (c) { return c.agency_id === id; }) || null;
        renderOverlay();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (!overlay.classList.contains('on') || !ring || ring.closed) return;
      if (e.key === 'Enter' && !e.target.closest('input,textarea,select')) { e.preventDefault(); if (ring.selection || !(ring.info && ring.info.candidates && ring.info.candidates.length)) answer(); }
      if (e.key === 'Escape') { e.preventDefault(); var r = ring; decline(r, 'declined'); closeOverlay(); }
    });
  }
  function showOverlay() { ensureOverlay(); renderOverlay(); overlay.classList.add('on'); }
  function closeOverlay() { if (ring) ring.closed = true; ring = null; if (overlay) overlay.classList.remove('on'); }

  function ctxRows(c) {
    var rows = [];
    if (c.last_activity && c.last_activity.label) rows.push(['Last', c.last_activity.label]);
    if (c.property) rows.push(['Probe', c.property]);
    if (c.summary) rows.push(['Context', c.summary]);
    if (c.pipeline_status) rows.push(['Status', String(c.pipeline_status).replace(/_/g, ' ').toLowerCase()]);
    return rows.map(function (kv) { return '<div class="k">' + esc(kv[0]) + '</div><div class="v' + (kv[0] === 'Probe' ? ' strong' : '') + '">' + esc(kv[1]) + '</div>'; }).join('');
  }

  function renderOverlay() {
    if (!overlay || !ring) return;
    var info = ring.info;
    var caller = (info && info.caller && info.caller.display) || ring.from || 'Unknown number';
    var cands = (info && info.candidates) || [];
    var sel = ring.selection;
    var html;
    if (!info) {
      html = '<div class="inc-label"><span class="dot"></span>Incoming call</div>' +
        '<div class="inc-name">' + esc(caller) + '</div><div class="inc-agency">Looking up who this is…</div>' +
        '<div class="inc-actions"><button class="btn btn-quiet" type="button" data-inc-decline>Decline</button>' +
        '<button class="inc-answer" type="button" data-inc-answer>' + phoneSvg() + 'Answer</button></div>';
    } else if (!cands.length) {
      html = '<div class="inc-label"><span class="dot"></span>Incoming call</div>' +
        '<div class="inc-name">' + esc(caller) + '</div>' +
        '<div class="inc-agency">No matching lead found.' + (info.error ? ' <span class="role">' + esc(info.error) + '</span>' : '') + '</div>' +
        '<div class="inc-actions"><button class="btn btn-quiet" type="button" data-inc-decline>Dismiss</button>' +
        '<button class="btn btn-secondary" type="button" data-inc-search>Search leads</button>' +
        '<button class="inc-answer" type="button" data-inc-answer>' + phoneSvg() + 'Answer</button></div>' +
        '<div class="inc-note">Answer takes the call as an unidentified lead — you can link it to a lead during the call.</div>';
    } else if (cands.length === 1) {
      var c = cands[0]; sel = ring.selection = ring.selection || c;
      html = '<div class="inc-label"><span class="dot"></span>Incoming callback</div>' +
        '<div class="inc-name">' + esc(c.contact_name || c.agency_name || caller) + '</div>' +
        '<div class="inc-agency">' + (c.contact_name ? esc(c.agency_name) : '<span class="role">No named contact</span>') + (c.contact_role ? '<span class="role">' + esc(c.contact_role) + '</span>' : '') + '</div>' +
        '<div class="inc-num">' + esc(c.matched_number || caller) + (c.reasons && c.reasons.length ? '<span class="why">' + esc(c.reasons[0]) + '</span>' : '') + '</div>' +
        (ctxRows(c) ? '<div class="inc-ctx">' + ctxRows(c) + '</div>' : '') +
        '<div class="inc-actions"><button class="btn btn-quiet" type="button" data-inc-decline>Decline</button>' +
        '<button class="inc-answer" type="button" data-inc-answer>' + phoneSvg() + 'Answer</button></div>';
    } else {
      html = '<div class="inc-label"><span class="dot"></span>Incoming callback — ' + cands.length + ' possible leads</div>' +
        '<div class="inc-name">' + esc(caller) + '</div>' +
        '<div class="inc-agency"><span class="note">This number is on more than one record. Choose who is calling.</span></div>' +
        '<div class="inc-pick">' + cands.map(function (c) {
          var on = sel && sel.agency_id === c.agency_id;
          var s = [c.reasons && c.reasons.length ? '' : (c.last_activity && c.last_activity.label), c.property, c.location].filter(Boolean).join(' · ');
          return '<button class="inc-cand' + (on ? ' on' : '') + '" type="button" data-inc-cand="' + esc(c.agency_id) + '">' +
            '<span class="rad"></span><span class="n">' + esc(c.contact_name || c.agency_name) + (c.contact_name ? '<small>' + esc(c.agency_name) + (c.contact_role ? ' · ' + esc(c.contact_role) : '') + '</small>' : '') + '</span>' +
            '<span class="sc">' + (c.preselected ? '<b>Likely</b>' : '') + esc((c.reasons && c.reasons[0]) || '') + '</span>' +
            '<span class="s">' + esc(s || 'No activity yet') + '</span></button>';
        }).join('') + '</div>' +
        (sel && ctxRows(sel) ? '<div class="inc-ctx">' + ctxRows(sel) + '</div>' : '') +
        '<div class="inc-actions"><button class="btn btn-quiet" type="button" data-inc-decline>Decline</button>' +
        '<button class="inc-answer" type="button" data-inc-answer' + (sel ? '' : ' disabled') + '>' + phoneSvg() + 'Answer</button></div>' +
        (sel ? '' : '<div class="inc-note">Pick the record this call belongs to, then Answer. Nothing is merged.</div>');
    }
    overlay.innerHTML = '<div class="inc-box">' + html + '</div>';
  }
  function phoneSvg() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>'; }

  function toast(title, sub) {
    if (!toasts) { toasts = document.createElement('div'); toasts.className = 'inc-toasts'; document.body.appendChild(toasts); }
    var el = document.createElement('div');
    el.className = 'inc-toast';
    el.innerHTML = '<b>' + esc(title) + '</b><div class="s">' + esc(sub || '') + '</div>';
    toasts.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 9000);
  }

  var NovusVoice = {
    ready: ready,
    state: function () { return readyState; },
    answerHandler: null,
    isBusy: null,
    onIncoming: null,
    loadInbound: loadInfo,
    intent: function (callId, intent, selection) { return postJson(INTENT_URL, Object.assign({ confirm: 'INBOUND_CALL', call_id: callId, intent: intent }, selection || {})); },
    toast: toast,
  };
  window.NovusVoice = NovusVoice;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { ready(); }); else ready();
})();
