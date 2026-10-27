/* novus/novus-mail.js — one-to-one email from your OWN connected inbox.
 *
 *   NovusMail.mountAccounts(el, { returnTo })   Settings → Email accounts
 *   NovusMail.mountTemplates(el)                Settings → Email templates (admin edits)
 *   NovusMail.compose({ ... })                  the compose window (Calling Mode, lead views)
 *
 * Presentation only — every rule (whose inbox, exactly-once, opt-out,
 * placeholders) is enforced by lib/mail-handlers.mjs. Nothing here ever sends
 * on its own: an email leaves only when the person presses Send in compose.
 * Used by operator.html and calling.html; styles use the shared tokens. */
(function () {
  'use strict';
  var OP = function (name) { return '/api/novus/personalisation?novus_operation=' + name; };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || d.success === false) { var e = new Error(d.error || ('Request failed (' + r.status + ')')); e.data = d; e.status = r.status; throw e; } return d; });
    });
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || d.success === false) { var e = new Error(d.error || ('Request failed (' + r.status + ')')); e.data = d; e.status = r.status; throw e; } return d; });
    });
  }
  function key() { return 'cmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  var PROVIDER_LABEL = { GOOGLE: 'Google Workspace / Gmail', MICROSOFT: 'Microsoft 365 / Outlook' };
  var REASON = {
    DENIED: 'You did not grant access, so nothing was connected.', WRONG_USER: 'That connection was started by a different NOVUS sign-in. Start again while signed in as yourself.',
    STATE_EXPIRED: 'That connection attempt expired. Start again.', ADDRESS_IN_USE: 'That inbox is already connected by another NOVUS user. Each person connects their own.',
    DOMAIN_NOT_ALLOWED: 'Only company inboxes can be connected.', SCOPE_MISSING: 'Permission to send email was not granted. Connect again and allow sending.',
    NO_REFRESH: 'The provider did not allow NOVUS to stay connected. Remove NOVUS from your account’s connected apps, then connect again.',
    NOT_CONFIGURED: 'Email sign-in is not set up on this deployment yet.', TOKEN_FAILED: 'The provider refused the connection. Try again.',
    IDENTITY_FAILED: 'The provider did not say which address this is. Try again.', UNVERIFIED: 'That address is not verified with the provider.',
  };

  /* ── styles (injected once; shared design tokens) ───────────────────── */
  function css() {
    if (document.getElementById('novus-mail-css')) return;
    var s = document.createElement('style'); s.id = 'novus-mail-css';
    s.textContent = [
      '.nm-ovl{position:fixed;inset:0;z-index:90;background:rgba(10,14,24,.45);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto}',
      '.nm-box{width:min(720px,100%);background:var(--bg-2,#fff);border:1px solid var(--hair-2,#e3e6ec);border-radius:var(--r-lg,12px);box-shadow:var(--shadow-md,0 10px 30px rgba(0,0,0,.18));padding:20px 22px}',
      '.nm-box h2{margin:0 0 4px;font-size:17px}.nm-sub{color:var(--ink-3,#6b7280);font-size:12.5px;margin-bottom:14px}',
      '.nm-row{display:grid;grid-template-columns:92px 1fr;gap:10px;align-items:center;margin:8px 0}.nm-row label{font-size:12px;color:var(--ink-3,#6b7280)}',
      '.nm-box textarea{min-height:240px;width:100%;box-sizing:border-box;font-family:inherit;line-height:1.5}.nm-box .nm-row input{width:100%;box-sizing:border-box}.nm-from{font-size:13px}.nm-from b{font-weight:600}',
      '.nm-warn{margin:10px 0}.nm-ok{margin:10px 0}.nm-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}.nm-acts .sp{flex:1}',
      '.nm-acct{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}.nm-acct .nm-meta{flex:1;min-width:220px;font-size:13px;line-height:1.6}',
      '.nm-team td,.nm-team th{font-size:12.5px}.nm-kind{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3,#6b7280)}',
      '.nm-tpl-grid{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:16px}.nm-tpl{padding:10px 12px;border:1px solid var(--hair,#e5e7eb);border-radius:var(--r-md,8px);margin-bottom:8px;cursor:pointer}',
      '.nm-tpl.on{border-color:var(--blue-line,#93c5fd);background:var(--blue-tint,#eff6ff)}.nm-tpl .n{font-weight:600;font-size:13px}.nm-tpl .s{font-size:12px;color:var(--ink-3,#6b7280)}',
      '.banner.ok{color:var(--green,#15803d);background:var(--green-tint,#f0fdf4);border:1px solid var(--green-line,#bbf7d0)}',
      '@media (max-width:720px){.nm-tpl-grid{grid-template-columns:1fr}.nm-row{grid-template-columns:1fr}}',
    ].join('');
    document.head.appendChild(s);
  }

  /* ── the account (shared by Settings and compose) ───────────────────── */
  var STATUS = null; var statusPromise = null;
  function loadStatus(force) {
    if (!force && statusPromise) return statusPromise;
    statusPromise = getJson(OP('mail-status')).then(function (d) { STATUS = d; return d; }).catch(function (e) { statusPromise = null; throw e; });
    return statusPromise;
  }
  function connect(provider, returnTo) {
    return post(OP('mail-connect-start'), { confirm: 'CONNECT_MAILBOX', provider: provider, return_to: returnTo || (location.pathname + location.hash.replace(/[?&]mail=[^&]*(&reason=[^&]*)?/, '')) })
      .then(function (d) { location.href = d.url; });
  }
  function accountHtml(d, returnTo) {
    var a = d.account; var setup = d.setup || {};
    var providers = (setup.providers || []).filter(function (p) { return p.configured; });
    var notReady = !setup.encryption_configured || !providers.length;
    var others = providers.filter(function (p) { return !a || p.provider !== a.provider; });
    var buttons = others.map(function (p) { return '<button class="btn ' + (a ? 'btn-quiet' : 'btn-primary') + ' btn-sm" data-nm-connect="' + p.provider + '" type="button">' + (a ? 'Switch to ' : 'Connect ') + esc(p.label) + '</button>'; }).join(' ');
    if (!a) {
      return '<div class="nm-acct"><div class="nm-meta"><b>No inbox connected.</b><br>Connect your own company inbox to send emails from NOVUS as yourself. You sign in with Google or Microsoft — NOVUS never sees your password and can only send, not read your mail.</div></div>'
        + (notReady ? '<div class="banner warn nm-warn"><div>Email sign-in is not set up on this deployment yet' + (!setup.encryption_configured ? ' (NOVUS_MAIL_TOKEN_KEY is missing)' : '') + (!providers.length ? ' (no Google or Microsoft OAuth client configured)' : '') + '. An administrator adds these in Vercel — see docs/MULTI_USER_OPERATIONS.md.</div></div>'
          : '<div class="nm-acts">' + buttons + '</div>');
    }
    var tone = a.status === 'CONNECTED' ? 't-green' : a.status === 'NEEDS_RECONNECT' ? 't-red' : 't-amber';
    var label = a.status === 'CONNECTED' ? 'Connected' : a.status === 'NEEDS_RECONNECT' ? 'Reconnect needed' : 'Error';
    return '<div class="nm-acct"><div class="nm-meta"><div class="nm-kind">' + esc(PROVIDER_LABEL[a.provider] || a.provider) + '</div>'
      + '<b style="font-size:15px">' + esc(a.email) + '</b> <span class="pill ' + tone + ' bare">' + label + '</span><br>'
      + 'Connected ' + esc(when(a.connected_at)) + (a.last_sent_at ? ' · last email sent ' + esc(when(a.last_sent_at)) : ' · nothing sent yet')
      + (a.last_error ? '<div class="banner ' + (a.status === 'NEEDS_RECONNECT' ? 'err' : 'warn') + ' nm-warn"><div><b>Last problem (' + esc(when(a.last_error_at)) + '):</b> ' + esc(a.last_error) + '</div></div>' : '')
      + '</div></div>'
      + '<div class="nm-acts">'
      + (a.status !== 'CONNECTED' ? '<button class="btn btn-primary btn-sm" data-nm-connect="' + esc(a.provider) + '" type="button">Reconnect</button>' : '')
      + '<input class="input" id="nm-test-to" type="email" placeholder="Send a test to… (type an address)" style="min-width:240px;font-size:12.5px" />'
      + '<button class="btn btn-secondary btn-sm" data-nm-test type="button">Send test email</button>'
      + '<span class="sp"></span><button class="btn btn-quiet btn-sm" data-nm-disconnect type="button" style="color:var(--red)">Disconnect</button></div>'
      + '<div id="nm-acct-msg"></div>'
      + (others.length ? '<div class="nm-acts" style="margin-top:6px">' + buttons + '</div>' : '');
  }
  function teamHtml(d) {
    if (!d.team) return '';
    return '<div class="section-head" style="margin-top:18px"><div class="section-title" style="font-size:13px">Team inboxes</div><div class="section-note">Who has connected which inbox. Each person manages their own; nobody can send from someone else’s.</div></div>'
      + '<div class="tablewrap"><table class="nm-team"><thead><tr><th>Person</th><th>Inbox</th><th>Status</th><th>Last sent</th></tr></thead><tbody>'
      + d.team.map(function (u) { var a = u.account; return '<tr><td><b>' + esc(u.display_name) + '</b></td><td>' + (a ? esc(a.email) + ' <span class="t-sub">' + esc(a.provider === 'GOOGLE' ? 'Gmail' : 'Outlook') + '</span>' : '<span class="muted">not connected</span>') + '</td><td>' + (a ? '<span class="pill ' + (a.status === 'CONNECTED' ? 't-green' : 't-red') + ' bare">' + esc(a.status === 'CONNECTED' ? 'Connected' : 'Reconnect needed') + '</span>' : '&mdash;') + '</td><td>' + (a && a.last_sent_at ? esc(when(a.last_sent_at)) : '&mdash;') + '</td></tr>'; }).join('')
      + '</tbody></table></div>';
  }
  function flashFromUrl(el) {
    var m = (location.hash + '&' + location.search).match(/[?&]mail=(connected|error)(?:&reason=([A-Z_]+))?/);
    if (!m) return;
    var box = document.createElement('div');
    box.className = 'banner ' + (m[1] === 'connected' ? 'ok' : 'err') + ' nm-ok';
    box.innerHTML = '<div>' + (m[1] === 'connected' ? '<b>Inbox connected.</b> Emails you send from NOVUS now go from your own inbox.' : '<b>Not connected.</b> ' + esc(REASON[m[2]] || 'Something went wrong — try again.')) + '</div>';
    el.insertBefore(box, el.firstChild);
    try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&]mail=[^&]*(&reason=[^&]*)?/, '') + location.hash.replace(/[?&]mail=[^&]*(&reason=[^&]*)?/, '')); } catch (e) { /* cosmetic */ }
  }
  function mountAccounts(el, opts) {
    css(); opts = opts || {};
    el.innerHTML = '<p class="muted"><span class="spin"></span> Loading email account…</p>';
    loadStatus(true).then(function (d) { el.innerHTML = accountHtml(d, opts.returnTo) + teamHtml(d); flashFromUrl(el); })
      .catch(function (e) { el.innerHTML = '<div class="banner err"><div>Email account status could not load. ' + esc(e.message) + '</div></div>'; });
    if (el.dataset.nmWired) return; el.dataset.nmWired = '1';
    el.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      var msg = function (html, tone) { var m = el.querySelector('#nm-acct-msg'); if (m) m.innerHTML = '<div class="banner ' + (tone || 'info') + ' nm-ok"><div>' + html + '</div></div>'; };
      if (t.dataset.nmConnect) { t.disabled = true; connect(t.dataset.nmConnect, opts.returnTo).catch(function (err) { t.disabled = false; msg(esc(err.message), 'err'); }); }
      if (t.hasAttribute('data-nm-disconnect')) {
        if (!confirm('Disconnect your inbox from NOVUS? You will not be able to send email from NOVUS until you connect again.')) return;
        post(OP('mail-disconnect'), { confirm: 'DISCONNECT_MAILBOX' }).then(function () { mountAccounts(el, opts); }).catch(function (err) { msg(esc(err.message), 'err'); });
      }
      if (t.hasAttribute('data-nm-test')) {
        var to = (el.querySelector('#nm-test-to') || {}).value || '';
        if (!to.trim()) { msg('Type the address to send the test to.', 'warn'); return; }
        if (!confirm('Send a test email to ' + to.trim() + ' from ' + (STATUS && STATUS.account ? STATUS.account.email : 'your inbox') + '?')) return;
        t.disabled = true;
        post(OP('mail-send'), { confirm: 'SEND_EMAIL', idempotency_key: key(), source: 'TEST', to: to.trim(), subject: 'NOVUS test email', body_text: 'This is a test email sent from NOVUS through your connected inbox. No reply needed.', expected_from: STATUS && STATUS.account ? STATUS.account.email : '' })
          .then(function (d) { t.disabled = false; msg('<b>Accepted by ' + esc(d.message.provider === 'GOOGLE' ? 'Gmail' : 'Outlook') + '</b> at ' + esc(when(d.message.accepted_at)) + ' — sent from ' + esc(d.message.from_email) + ' to ' + esc(d.message.to_email) + '.', 'ok'); })
          .catch(function (err) { t.disabled = false; msg(esc(err.message), 'err'); loadStatus(true).then(function (d) { STATUS = d; }); });
      }
    });
  }

  /* ── templates ───────────────────────────────────────────────────────── */
  var TPL = null;
  function loadTemplates(force) { if (!force && TPL) return Promise.resolve(TPL); return getJson(OP('mail-templates')).then(function (d) { TPL = d; return d; }); }
  var PLACEHOLDER_NOTE = '{{first_name}} {{name}} {{agency}} {{location}} {{property}} {{sender_name}} {{sender_first_name}} {{sender_email}} {{meeting_time}} {{callback_time}}';
  function mountTemplates(el, opts) {
    css(); opts = opts || {};
    var admin = opts.admin !== false;
    var sel = null; var isNew = false;
    function render() {
      var d = TPL; var list = d.templates || [];
      if (!sel && !isNew && list.length) sel = list[0].template_key;
      var fam = list.find(function (t) { return t.template_key === sel; });
      var ver = fam ? (fam.versions.find(function (v) { return v.template_id === (fam.view_id || fam.current_id); }) || fam.versions[0]) : null;
      var purposes = d.purposes || {};
      var left = list.map(function (t) {
        return '<div class="nm-tpl' + (t.template_key === sel && !isNew ? ' on' : '') + '" data-nm-tpl="' + esc(t.template_key) + '"><div class="n">' + esc(t.name) + (t.archived ? ' <span class="pill t-grey bare">archived</span>' : '') + '</div><div class="s">' + esc(purposes[t.purpose] || t.purpose) + ' · v' + (t.versions.find(function (v) { return v.template_id === t.current_id; }) || t.versions[0]).version + ' · ' + t.versions.length + ' version' + (t.versions.length === 1 ? '' : 's') + '</div></div>';
      }).join('') + (admin ? '<button class="btn btn-quiet btn-sm" data-nm-tpl-new type="button">+ New template</button>' : '');
      var v = isNew ? { template_id: '', name: '', purpose: 'GENERAL', subject: '', body: '', notes: '', version: 1, status: 'CURRENT', sent_count: 0 } : ver;
      var right = !v ? '<div class="note">Select a template.</div>'
        : '<div class="field"><label class="field-l">Name</label><input class="input block" id="nm-t-name" value="' + esc(v.name) + '"' + (admin ? '' : ' readonly') + ' /></div>'
          + '<div class="field" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px"><div><label class="field-l">For</label><select class="input block" id="nm-t-purpose"' + (admin ? '' : ' disabled') + '>' + Object.keys(purposes).map(function (k) { return '<option value="' + k + '"' + (k === v.purpose ? ' selected' : '') + '>' + esc(purposes[k]) + '</option>'; }).join('') + '</select></div>'
          + '<div><label class="field-l">Version</label>' + (fam && fam.versions.length > 1 && !isNew ? '<select class="input block" id="nm-t-ver">' + fam.versions.map(function (x) { return '<option value="' + esc(x.template_id) + '"' + (x.template_id === v.template_id ? ' selected' : '') + '>v' + x.version + ' · ' + (x.status === 'CURRENT' ? 'in use' : x.status.toLowerCase()) + '</option>'; }).join('') + '</select>' : '<input class="input block" value="v' + v.version + '" readonly />') + '</div>'
          + '<div><label class="field-l">Sent with this version</label><input class="input block" value="' + (v.sent_count || 0) + '" readonly /></div></div>'
          + '<div class="field"><label class="field-l">Subject</label><input class="input block" id="nm-t-subject" value="' + esc(v.subject) + '"' + (admin ? '' : ' readonly') + ' /></div>'
          + '<div class="field"><label class="field-l">Body</label><textarea class="input block" id="nm-t-body" style="min-height:220px;width:100%;box-sizing:border-box;line-height:1.5"' + (admin ? '' : ' readonly') + '>' + esc(v.body) + '</textarea><div class="field-note">Placeholders: <span class="mono">' + esc(PLACEHOLDER_NOTE) + '</span>. You always review and edit the final email before it is sent.</div></div>'
          + (admin ? '<div class="field"><label class="field-l">Notes</label><input class="input block" id="nm-t-notes" value="' + esc(v.notes || '') + '" placeholder="What changed in this version" /></div>' : '')
          + (v.sent_count ? '<div class="hintbox"><b>' + v.sent_count + ' email' + (v.sent_count === 1 ? ' was' : 's were') + ' sent with this version.</b> Its wording is kept; saving creates the next version.</div>' : '')
          + (admin ? '<div class="btnrow" style="margin-top:14px"><button class="btn btn-primary" data-nm-t-save type="button">' + (v.sent_count ? 'Save as new version' : 'Save') + '</button>'
            + (!isNew && v.status !== 'CURRENT' ? '<button class="btn btn-secondary" data-nm-t-use type="button">Use this version</button>' : '')
            + (!isNew ? '<button class="btn btn-quiet" data-nm-t-dup type="button">Duplicate as new template</button>' : '')
            + (!isNew && v.status !== 'ARCHIVED' ? '<button class="btn btn-quiet" data-nm-t-archive type="button">Archive</button>' : '')
            + (isNew ? '<button class="btn btn-quiet" data-nm-t-cancel type="button">Cancel</button>' : '') + '</div>' : '')
          + '<div id="nm-t-err" class="formerr"></div>';
      el.innerHTML = '<div class="nm-tpl-grid"><div>' + left + '</div><div class="card"><div class="card-body">' + right + '</div></div></div>';
      el._v = v; el._fam = fam;
    }
    function reload(keep) { return loadTemplates(true).then(function () { if (keep) sel = keep; render(); }); }
    el.innerHTML = '<p class="muted"><span class="spin"></span> Loading templates…</p>';
    loadTemplates(true).then(render).catch(function (e) { el.innerHTML = '<div class="banner err"><div>Templates could not load. ' + esc(e.message) + '</div></div>'; });
    if (el.dataset.nmWired) return; el.dataset.nmWired = '1';
    var err = function (m) { var x = el.querySelector('#nm-t-err'); if (x) { x.textContent = m; x.classList.add('show'); } };
    el.addEventListener('change', function (e) { if (e.target.id === 'nm-t-ver' && el._fam) { el._fam.view_id = e.target.value; render(); } });
    el.addEventListener('click', function (e) {
      var row = e.target.closest('[data-nm-tpl]'); if (row) { sel = row.dataset.nmTpl; isNew = false; render(); return; }
      var t = e.target.closest('button'); if (!t) return;
      var v = el._v;
      if (t.hasAttribute('data-nm-tpl-new')) { isNew = true; sel = null; render(); return; }
      if (t.hasAttribute('data-nm-t-cancel')) { isNew = false; render(); return; }
      if (t.hasAttribute('data-nm-t-save')) {
        post(OP('mail-template-save'), { confirm: 'SAVE_TEMPLATE', template_id: isNew ? '' : v.template_id, name: el.querySelector('#nm-t-name').value, purpose: el.querySelector('#nm-t-purpose').value, subject: el.querySelector('#nm-t-subject').value, body: el.querySelector('#nm-t-body').value, notes: (el.querySelector('#nm-t-notes') || {}).value || '' })
          .then(function (d) { isNew = false; if (el._fam) el._fam.view_id = ''; return reload(d.template.template_key); }).catch(function (x) { err(x.message); });
      }
      if (t.hasAttribute('data-nm-t-use')) post(OP('mail-template-status'), { confirm: 'SET_TEMPLATE_STATUS', template_id: v.template_id, status: 'CURRENT' }).then(function () { if (el._fam) el._fam.view_id = ''; return reload(sel); }).catch(function (x) { err(x.message); });
      if (t.hasAttribute('data-nm-t-archive')) { if (!confirm('Archive this version? It stays in history and can be used again later.')) return; post(OP('mail-template-status'), { confirm: 'SET_TEMPLATE_STATUS', template_id: v.template_id, status: 'ARCHIVED' }).then(function () { return reload(sel); }).catch(function (x) { err(x.message); }); }
      if (t.hasAttribute('data-nm-t-dup')) post(OP('mail-template-duplicate'), { confirm: 'DUPLICATE_TEMPLATE', template_id: v.template_id }).then(function (d) { return reload(d.template.template_key); }).catch(function (x) { err(x.message); });
    });
  }

  /* ── compose ─────────────────────────────────────────────────────────── */
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function fill(textValue, vars) {
    return String(textValue || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, function (m, k) { return vars[k] ? vars[k] : m; });
  }
  /* ctx: { agency_id, agency_name, contact_name, to, location, property, purpose,
     source ('CALLING'|'PROFILE'), call_id, meeting_time, callback_time, onSent } */
  function compose(ctx) {
    css(); ctx = ctx || {};
    var ovl = document.createElement('div'); ovl.className = 'nm-ovl'; ovl.setAttribute('role', 'dialog'); ovl.setAttribute('aria-modal', 'true');
    ovl.innerHTML = '<div class="nm-box"><p class="muted"><span class="spin"></span> Preparing email…</p></div>';
    document.body.appendChild(ovl);
    var box = ovl.firstChild; var idem = key(); var sent = false; var ackOptOut = false;
    function close() { if (!sent && box.querySelector('#nm-body') && box.querySelector('#nm-body').value.trim() && !confirm('Close without sending? Your edits will be lost.')) return; ovl.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ovl.addEventListener('click', function (e) { if (e.target === ovl) close(); });
    Promise.all([loadStatus(true), loadTemplates(false).catch(function () { return { templates: [], purposes: {} }; }), getJson(OP('my-preferences')).catch(function () { return { preferences: {} }; })]).then(function (r) {
      var st = r[0], tp = r[1], prefs = (r[2] && r[2].preferences) || {};
      var me = (window.NovusAuth && window.NovusAuth.me) || {};
      var acct = st.account;
      var vars = { first_name: firstName(ctx.contact_name), name: ctx.contact_name || '', agency: ctx.agency_name || '', location: ctx.location || '', property: ctx.property || '',
        sender_name: me.display_name || '', sender_first_name: firstName(me.display_name), sender_email: acct ? acct.email : '', meeting_time: ctx.meeting_time || '', callback_time: ctx.callback_time || '' };
      var live = (tp.templates || []).filter(function (t) { return !t.archived; });
      var ordered = live.filter(function (t) { return t.purpose === ctx.purpose; }).concat(live.filter(function (t) { return t.purpose !== ctx.purpose; }));
      var purposes = tp.purposes || {};
      var fromHtml = acct && acct.status === 'CONNECTED'
        ? '<span class="nm-from"><b>' + esc(acct.email) + '</b> <span class="t-sub">your ' + esc(acct.provider === 'GOOGLE' ? 'Gmail' : 'Outlook') + ' inbox</span></span>'
        : '<div class="banner err" style="margin:0"><div>' + (acct ? 'Your connection to <b>' + esc(acct.email) + '</b> has expired.' : 'You have not connected your inbox yet.') + ' NOVUS only sends from your own inbox. '
          + ((st.setup && st.setup.providers || []).filter(function (p) { return p.configured; }).map(function (p) { return '<button class="btn btn-primary btn-sm" data-nm-connect="' + p.provider + '" type="button">' + (acct ? 'Reconnect' : 'Connect') + ' ' + esc(p.label) + '</button>'; }).join(' ') || 'Email sign-in is not set up on this deployment yet.') + '</div></div>';
      box.innerHTML = '<h2>Email ' + esc(ctx.contact_name || ctx.agency_name || '') + '</h2>'
        + '<div class="nm-sub">A one-to-one email from your own inbox' + (ctx.agency_name ? ' · ' + esc(ctx.agency_name) : '') + '. It is sent only when you press Send, and appears on the agency’s timeline.</div>'
        + '<div class="nm-row"><label>Template</label><select class="input" id="nm-tpl"><option value="">Blank email</option>' + ordered.map(function (t) { var p = purposes[t.purpose] || t.purpose; return '<option value="' + esc(t.current_id) + '">' + esc(t.name) + (p.toLowerCase() === String(t.name).toLowerCase() ? '' : ' — ' + esc(p)) + '</option>'; }).join('') + '</select></div>'
        + '<div class="nm-row"><label>From</label><div>' + fromHtml + '</div></div>'
        + '<div class="nm-row"><label for="nm-to">To</label><input class="input" id="nm-to" type="email" value="' + esc(ctx.to || '') + '" placeholder="name@agency.co.uk" /></div>'
        + '<div class="nm-row"><label for="nm-subject">Subject</label><input class="input" id="nm-subject" /></div>'
        + '<div class="nm-row" style="align-items:start"><label for="nm-body">Message</label><textarea class="input" id="nm-body"></textarea></div>'
        + '<div id="nm-msg"></div>'
        + '<div class="nm-acts"><button class="btn btn-quiet" data-nm-close type="button">Cancel</button><span class="sp"></span><span class="t-sub" id="nm-left"></span><button class="btn btn-primary" id="nm-send" type="button"' + (acct && acct.status === 'CONNECTED' ? '' : ' disabled') + '>Send email</button></div>';
      var tplSel = box.querySelector('#nm-tpl'); var sub = box.querySelector('#nm-subject'); var body = box.querySelector('#nm-body');
      var chosen = null;
      function versionOf(id) { var f = (tp.templates || []).find(function (t) { return t.versions.some(function (v) { return v.template_id === id; }); }); return f ? f.versions.find(function (v) { return v.template_id === id; }) : null; }
      function applyTemplate() {
        chosen = versionOf(tplSel.value);
        var sig = prefs.email_signature ? '\n\n' + prefs.email_signature : '';
        sub.value = chosen ? fill(chosen.subject, vars) : '';
        body.value = chosen ? fill(chosen.body, vars) + sig : (vars.first_name ? 'Hi ' + vars.first_name + ',\n\n' : '') + sig;
        check();
      }
      function check() {
        var left = (sub.value + '\n' + body.value).match(/\{\{\s*[a-z_]+\s*\}\}/g) || [];
        box.querySelector('#nm-left').textContent = left.length ? 'Fill in: ' + Array.from(new Set(left)).join(' ') : '';
      }
      tplSel.addEventListener('change', function () { if ((sub.value || body.value.trim()) && chosen !== versionOf(tplSel.value) && !confirm('Replace the current subject and message with this template?')) return; applyTemplate(); });
      sub.addEventListener('input', check); body.addEventListener('input', check);
      if (ordered.length && ordered[0].purpose === ctx.purpose) tplSel.value = ordered[0].current_id;
      applyTemplate();
      var msg = function (html, tone) { box.querySelector('#nm-msg').innerHTML = '<div class="banner ' + (tone || 'info') + ' nm-warn"><div>' + html + '</div></div>'; };
      box.addEventListener('click', function (e) {
        var t = e.target.closest('button'); if (!t) return;
        if (t.hasAttribute('data-nm-close')) { close(); return; }
        if (t.dataset.nmConnect) { if (!confirm('Leave this email to connect your inbox? The draft will not be kept.')) return; sent = true; connect(t.dataset.nmConnect).catch(function (err) { msg(esc(err.message), 'err'); }); return; }
        if (t.id !== 'nm-send') return;
        var to = box.querySelector('#nm-to').value.trim();
        if (!to) { msg('Enter the recipient’s email address.', 'warn'); return; }
        if (!confirm('Send this email to ' + to + ' from ' + acct.email + '?')) return;
        t.disabled = true; t.textContent = 'Sending…';
        post(OP('mail-send'), {
          confirm: 'SEND_EMAIL', idempotency_key: idem, source: ctx.source || 'PROFILE', agency_id: ctx.agency_id || '', contact_name: ctx.contact_name || '', call_id: ctx.call_id || '',
          to: to, subject: sub.value, body_text: body.value, template_id: chosen ? chosen.template_id : '', template_version: chosen ? String(chosen.version) : '', purpose: chosen ? chosen.purpose : (ctx.purpose || ''),
          expected_from: acct.email, acknowledge_opt_out: ackOptOut,
        }).then(function (d) {
          sent = true;
          box.innerHTML = '<h2>Email sent</h2><div class="banner ok nm-ok"><div><b>Accepted by ' + esc(d.message.provider === 'GOOGLE' ? 'Gmail' : 'Outlook') + '</b> at ' + esc(when(d.message.accepted_at)) + (d.duplicate ? ' (this exact email had already been sent — it was not sent again)' : '') + '.<br>From ' + esc(d.message.from_email) + ' to ' + esc(d.message.to_email) + ' — “' + esc(d.message.subject) + '”.<br>It is on the agency timeline and in your Sent folder. Replies come to your own inbox.</div></div><div class="nm-acts"><span class="sp"></span><button class="btn btn-primary" data-nm-done type="button">Done</button></div>';
          box.querySelector('[data-nm-done]').addEventListener('click', function () { ovl.remove(); document.removeEventListener('keydown', onKey); });
          if (typeof ctx.onSent === 'function') ctx.onSent(d.message);
        }).catch(function (err) {
          t.disabled = false; t.textContent = 'Send email';
          var code = err.data && err.data.code;
          if (code === 'OPTED_OUT') { msg(esc(err.message) + ' <button class="btn btn-secondary btn-sm" data-nm-ack type="button">They asked for it — send anyway</button>', 'warn'); return; }
          if (code === 'UNCONFIRMED') { sent = true; t.disabled = true; }
          if (code === 'NEEDS_RECONNECT' || code === 'NOT_CONNECTED') t.disabled = true;
          msg(esc(err.message), 'err');
        });
      });
      box.addEventListener('click', function (e) { if (e.target.closest('[data-nm-ack]')) { ackOptOut = true; box.querySelector('#nm-send').click(); } });
    }).catch(function (err) { box.innerHTML = '<div class="banner err"><div>Email could not be prepared. ' + esc(err.message) + '</div></div><div class="nm-acts"><span class="sp"></span><button class="btn btn-secondary" type="button">Close</button></div>'; box.querySelector('button').addEventListener('click', function () { ovl.remove(); }); });
  }

  window.NovusMail = { mountAccounts: mountAccounts, mountTemplates: mountTemplates, compose: compose, status: loadStatus };
})();
