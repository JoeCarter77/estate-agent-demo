// lib/mail-handlers.mjs — Settings → Email accounts, the template library and
// one-to-one sending from a person's OWN connected inbox (lib/mailbox.mjs).
// All operations are ?novus_operation= branches on api/novus/personalisation.js
// (the 12-function ceiling), plus the OAuth callback rewrite
// /api/novus/mail/oauth/callback → mail-oauth-callback.
//
//   GET  mail-status              my connection, setup state, team connection list (admins)
//   POST mail-connect-start       confirm=CONNECT_MAILBOX, provider, return_to → { url }
//   GET  mail-oauth-callback      provider redirect target → 302 back to NOVUS
//   POST mail-disconnect          confirm=DISCONNECT_MAILBOX
//   POST mail-send                confirm=SEND_EMAIL — the ONLY way an email leaves a
//                                 connected inbox: a person pressing Send
//   GET  mail-templates           the shared library (seeded once if empty)
//   POST mail-template-save       confirm=SAVE_TEMPLATE (admin)
//   POST mail-template-status     confirm=SET_TEMPLATE_STATUS (admin)
//   POST mail-template-duplicate  confirm=DUPLICATE_TEMPLATE (admin)
//
// MANUAL ONLY. Nothing in NOVUS calls mail-send on its own: no call outcome,
// poller, cron or reconcile reaches it. Each send carries an idempotency key
// (one per compose window) held in Redis, so a double click, a retry or two
// tabs can never send the same email twice. Every attempt — accepted or not —
// is a row in EMAIL_MESSAGES (the audit trail and the timeline's source).

import crypto from 'node:crypto';
import { getRepo } from './sheets.mjs';
import { kvStore } from './kv.mjs';
import {
  MAIL_PROVIDERS, MailError, appOrigin, completeConnect, disconnectAccount, mailSetupStatus, markAccount,
  publicAccount, readAccount, safeReturnTo, sendViaMailbox, startConnect,
} from './mailbox.mjs';
import {
  EMAIL_TEMPLATES_HEADER, EMAIL_TEMPLATES_SCHEMA_NOTE, EMAIL_TEMPLATES_TAB, STARTER_TEMPLATES, TEMPLATE_PURPOSES, TEMPLATE_STATUSES,
  newTemplateId, newTemplateKey, rowFor, templateLibrary, templateRecords, validateTemplate,
} from './email-templates.mjs';
import { claimLeadIfUnassigned, claimingUser } from './lead-ownership.mjs';
import { readRoster } from './ownership-handlers.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const lower = (value) => text(value).toLowerCase();
const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const isAdmin = (req) => req?.novusUser?.role === 'ADMIN';
const EMAIL_RE = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

// ── EMAIL_MESSAGES: every one-to-one send attempt ─────────────────────────
export const EMAIL_MESSAGES_TAB = 'EMAIL_MESSAGES';
export const EMAIL_MESSAGES_HEADER = Object.freeze([
  'message_id', 'idempotency_key', 'agency_id', 'contact_name', 'to_email', 'cc_emails', 'from_email', 'sender_user_id', 'sender_name',
  'provider', 'provider_message_id', 'provider_thread_id', 'subject', 'body_text', 'template_id', 'template_version',
  'source', 'call_id', 'status', 'error', 'created_at', 'accepted_at', 'metadata_json',
]);
export const EMAIL_MESSAGES_SCHEMA_NOTE = 'One row per one-to-one email a person sent from their OWN connected inbox (Settings → Email accounts). status SENDING → SENT (the provider accepted it), FAILED (refused, nothing sent) or UNCONFIRMED (the connection dropped mid-send; check Sent items). source: CALLING / PROFILE (manual, to a prospect) or TEST. Instantly campaign email is NOT here (CAMPAIGN_EVENTS). Append-only; never edit by hand.';
export const MESSAGE_SOURCES = Object.freeze(['CALLING', 'PROFILE', 'TEST']);

const newMessageId = () => `eml_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
const sendKey = (key) => `novus:mail:send:${crypto.createHash('sha256').update(text(key)).digest('hex').slice(0, 40)}`;
const seedLockKey = 'novus:mail:templates:seed';

function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}
const noteRow = (header, note) => { const row = header.map((_, i) => (i === 0 ? 'SCHEMA NOTE' : '')); row[1] = note; return row; };
async function optionalTable(repo, tab) { try { return await repo.getTable(tab); } catch { return { header: [], rows: [] }; } }

export function emailMessageRecords(table) { return records(table, 'message_id').map((r) => r.obj); }

const errorStatus = (code) => ({
  NOT_CONFIGURED: 503, BAD_PROVIDER: 400, NEEDS_RECONNECT: 409, NOT_CONNECTED: 409, PROVIDER_UNAVAILABLE: 502, PROVIDER_REFUSED: 502, UNCONFIRMED: 504,
}[code] || 400);

// ── GET mail-status ───────────────────────────────────────────────────────
export async function handleMailStatus(req, res) {
  noStore(res);
  const me = req.novusUser;
  try {
    const store = kvStore();
    const mine = publicAccount(await readAccount(me.user_id, { kv: store }));
    let team = null;
    if (isAdmin(req)) {
      // Administrators see who has connected what (address + status) — never tokens.
      const roster = (await readRoster(getRepo()).catch(() => [])).filter((u) => u.status !== 'DELETED');
      team = await Promise.all(roster.map(async (u) => {
        const acct = publicAccount(await readAccount(u.user_id, { kv: store }).catch(() => null));
        return { user_id: u.user_id, display_name: u.display_name, role: u.role, account: acct ? { provider: acct.provider, email: acct.email, status: acct.status, connected_at: acct.connected_at, last_sent_at: acct.last_sent_at, last_error: acct.last_error } : null };
      }));
    }
    return res.status(200).json({ success: true, user_id: me.user_id, account: mine, setup: mailSetupStatus(), team });
  } catch {
    return res.status(503).json({ success: false, retryable: true, error: 'Email account status could not be read just now.' });
  }
}

// ── POST mail-connect-start ───────────────────────────────────────────────
export async function handleMailConnectStart(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'CONNECT_MAILBOX') return res.status(400).json({ success: false, error: 'Missing confirm=CONNECT_MAILBOX' });
  const provider = upper(req.body?.provider);
  if (!MAIL_PROVIDERS.includes(provider)) return res.status(400).json({ success: false, error: 'Choose Google or Microsoft.' });
  if (req.novusUser?.via !== 'session') return res.status(400).json({ success: false, error: 'Connect your inbox from your own NOVUS sign-in, not the machine credential.' });
  try {
    const out = await startConnect({ user: req.novusUser, sid: req.novusUser.sid, provider, origin: appOrigin(req), returnTo: req.body?.return_to });
    return res.status(200).json({ success: true, url: out.url, redirect_uri: out.redirect_uri });
  } catch (err) {
    if (err instanceof MailError) return res.status(errorStatus(err.code)).json({ success: false, code: err.code, error: err.message });
    return res.status(503).json({ success: false, retryable: true, error: 'Could not start the connection just now. Try again.' });
  }
}

// ── GET mail-oauth-callback ───────────────────────────────────────────────
// The provider sends the browser here. Always answers with a redirect back
// into NOVUS carrying only a status and a reason CODE (no address, no token).
export async function handleMailOAuthCallback(req, res) {
  noStore(res);
  const back = (returnTo, params) => {
    const target = safeReturnTo(returnTo);
    const [path, hash = ''] = target.split('#');
    const qs = new URLSearchParams(params).toString();
    const location = hash ? `${path}#${hash}${hash.includes('?') ? '&' : '?'}${qs}` : `${path}${path.includes('?') ? '&' : '?'}${qs}`;
    res.setHeader('Location', location);
    return res.status(302).end();
  };
  const providerError = text(req.query?.error);
  try {
    if (providerError) {
      // Consume the state so it cannot be replayed, then go back.
      try { await kvStore().command(['DEL', `novus:mail:state:${text(req.query?.state)}`]); } catch { /* expires anyway */ }
      return back('', { mail: 'error', reason: providerError === 'access_denied' ? 'DENIED' : 'PROVIDER_ERROR' });
    }
    const out = await completeConnect({ user: req.novusUser, sid: req.novusUser?.sid, state: req.query?.state, code: req.query?.code });
    return back(out.return_to, { mail: 'connected' });
  } catch (err) {
    return back('', { mail: 'error', reason: err instanceof MailError ? err.code : 'UNAVAILABLE' });
  }
}

// ── POST mail-disconnect ──────────────────────────────────────────────────
export async function handleMailDisconnect(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'DISCONNECT_MAILBOX') return res.status(400).json({ success: false, error: 'Missing confirm=DISCONNECT_MAILBOX' });
  try {
    const out = await disconnectAccount(req.novusUser.user_id);
    return res.status(200).json({ success: true, ...out });
  } catch {
    return res.status(503).json({ success: false, retryable: true, error: 'Could not disconnect just now. Try again.' });
  }
}

// ── POST mail-send ────────────────────────────────────────────────────────
function parseRecipients(value, max) {
  const list = (Array.isArray(value) ? value : text(value).split(/[,;\s]+/)).map(lower).filter(Boolean);
  if (list.length > max) return { error: `At most ${max} address${max === 1 ? '' : 'es'} here.` };
  const bad = list.find((a) => !EMAIL_RE.test(a));
  if (bad) return { error: `"${bad}" is not a valid email address.` };
  return { list: [...new Set(list)] };
}

function optedOut(agencyId, replies, campaignEvents) {
  const id = text(agencyId);
  return records(replies, 'reply_event_id').some((r) => text(r.obj.agency_id) === id && (upper(r.obj.suppression_type) === 'PERMANENT' || upper(r.obj.classification) === 'OPT_OUT'))
    || records(campaignEvents, 'event_id').some((e) => text(e.obj.agency_id) === id && upper(e.obj.event_type) === 'LEAD_UNSUBSCRIBED');
}

export async function handleMailSend(req, res) {
  noStore(res);
  const body = req.body || {};
  if (text(body.confirm) !== 'SEND_EMAIL') return res.status(400).json({ success: false, error: 'Missing confirm=SEND_EMAIL' });
  const me = req.novusUser;
  if (me?.via !== 'session') return res.status(400).json({ success: false, error: 'Email is sent from your own NOVUS sign-in only.' });
  const source = upper(body.source) || 'PROFILE';
  if (!MESSAGE_SOURCES.includes(source)) return res.status(400).json({ success: false, error: 'Unknown source' });
  const idem = text(body.idempotency_key);
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(idem)) return res.status(400).json({ success: false, error: 'Missing idempotency_key' });
  const to = parseRecipients(body.to, 1);
  if (to.error || !to.list.length) return res.status(400).json({ success: false, error: to.error || 'Enter the recipient\'s email address.' });
  const cc = parseRecipients(body.cc || [], 3);
  if (cc.error) return res.status(400).json({ success: false, error: cc.error });
  const subject = text(body.subject).replace(/[\r\n]+/g, ' ').slice(0, 300);
  const bodyText = String(body.body_text ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (!subject) return res.status(400).json({ success: false, error: 'The subject cannot be empty.' });
  if (!bodyText) return res.status(400).json({ success: false, error: 'The message cannot be empty.' });
  const unfilled = `${subject}\n${bodyText}`.match(/\{\{\s*[a-z_]+\s*\}\}/);
  if (unfilled) return res.status(400).json({ success: false, error: `Fill in ${unfilled[0]} before sending.` });
  const agencyId = text(body.agency_id);
  if (source !== 'TEST' && !agencyId) return res.status(400).json({ success: false, error: 'agency_id is required' });

  // 1) The sender is the caller's own connected inbox — or nothing.
  let store;
  let account;
  try { store = kvStore(); account = await readAccount(me.user_id, { kv: store }); }
  catch { return res.status(503).json({ success: false, retryable: true, error: 'Your email connection could not be checked just now. Nothing was sent.' }); }
  if (!account) return res.status(409).json({ success: false, code: 'NOT_CONNECTED', error: 'You have not connected your inbox yet. Connect it in Settings → Email accounts — NOVUS never sends from someone else\'s.' });
  if (account.status === 'NEEDS_RECONNECT') return res.status(409).json({ success: false, code: 'NEEDS_RECONNECT', error: `Your connection to ${account.email} has expired. Reconnect it in Settings → Email accounts. Nothing was sent.` });
  if (body.expected_from && lower(body.expected_from) !== lower(account.email)) {
    return res.status(409).json({ success: false, code: 'SENDER_CHANGED', error: `Your connected inbox is now ${account.email}, not ${lower(body.expected_from)}. Review the sender and send again.` });
  }

  const repo = getRepo();
  // 2) The agency, and its opt-out state (a deliberate override is recorded).
  let agencyName = '';
  if (agencyId) {
    const agency = await repo.findById('AGENCIES', 'agency_id', agencyId).catch(() => null);
    if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });
    agencyName = text(agency.obj.clean_agency_name || agency.obj.agency_name);
    if (source !== 'TEST') {
      const [replies, campaignEvents] = await Promise.all([optionalTable(repo, 'REPLY_EVENTS'), optionalTable(repo, 'CAMPAIGN_EVENTS')]);
      if (optedOut(agencyId, replies, campaignEvents) && body.acknowledge_opt_out !== true) {
        return res.status(409).json({ success: false, code: 'OPTED_OUT', opted_out: true, error: `${agencyName || 'This agency'} has opted out of email. Only send if they asked for this email on a call — confirm to send anyway.` });
      }
    }
  }

  // 3) Exactly once. The key is taken atomically before anything is sent.
  let taken;
  try { taken = await store.command(['SET', sendKey(idem), JSON.stringify({ state: 'SENDING', user_id: me.user_id }), 'NX', 'EX', 86400]); }
  catch { return res.status(503).json({ success: false, retryable: true, error: 'NOVUS could not guarantee this email is sent only once just now, so it was not sent. Try again.' }); }
  if (taken !== 'OK') {
    let prior = null; try { prior = JSON.parse(await store.command(['GET', sendKey(idem)]) || 'null'); } catch { prior = null; }
    if (prior?.state === 'DONE' && prior.user_id === me.user_id) return res.status(200).json({ success: true, duplicate: true, message: prior.message });
    if (prior?.state === 'UNCONFIRMED') return res.status(409).json({ success: false, code: 'UNCONFIRMED', error: 'An earlier attempt at this exact email may have been sent. Check your Sent folder; to send again, start a new email.' });
    return res.status(409).json({ success: false, code: 'IN_PROGRESS', error: 'This email is already being sent. Check the timeline before trying again.' });
  }

  const now = new Date().toISOString();
  const messageId = newMessageId();
  const row = {
    message_id: messageId, idempotency_key: idem, agency_id: agencyId, contact_name: text(body.contact_name).slice(0, 120),
    to_email: to.list[0], cc_emails: cc.list.join(', '), from_email: account.email, sender_user_id: me.user_id, sender_name: text(me.display_name),
    provider: account.provider, provider_message_id: '', provider_thread_id: '', subject, body_text: bodyText,
    template_id: text(body.template_id).slice(0, 60), template_version: text(body.template_version).slice(0, 10),
    source, call_id: text(body.call_id).slice(0, 60), status: 'SENDING', error: '', created_at: now, accepted_at: '',
    metadata_json: JSON.stringify({ purpose: upper(body.purpose).slice(0, 40), ...(body.acknowledge_opt_out === true ? { opt_out_overridden: true } : {}) }),
  };
  // 4) The audit row exists BEFORE the provider is called.
  try {
    await repo.ensureTab(EMAIL_MESSAGES_TAB, [...EMAIL_MESSAGES_HEADER], noteRow(EMAIL_MESSAGES_HEADER, EMAIL_MESSAGES_SCHEMA_NOTE));
    await repo.appendRowsBatch(EMAIL_MESSAGES_TAB, [rowFor(EMAIL_MESSAGES_HEADER, row)]);
  } catch {
    await store.command(['DEL', sendKey(idem)]).catch(() => {});
    return res.status(503).json({ success: false, retryable: true, error: 'NOVUS could not record the email, so it was not sent. Try again.' });
  }

  // 5) Send through the caller's own mailbox.
  let sent;
  try {
    sent = await sendViaMailbox(account, { to: to.list, cc: cc.list, subject, body: bodyText, messageId }, { kv: store });
  } catch (err) {
    const code = err instanceof MailError ? err.code : 'PROVIDER_UNAVAILABLE';
    const message = err instanceof MailError ? err.message : 'The email provider did not answer. Nothing was sent — try again shortly.';
    const unconfirmed = code === 'UNCONFIRMED';
    await repo.updateById(EMAIL_MESSAGES_TAB, 'message_id', messageId, { status: unconfirmed ? 'UNCONFIRMED' : 'FAILED', error: `${code}: ${message}`.slice(0, 400) }).catch(() => {});
    await markAccount(me.user_id, { ...(code === 'NEEDS_RECONNECT' ? { status: 'NEEDS_RECONNECT' } : {}), last_error: message, last_error_at: new Date().toISOString() }, { kv: store }).catch(() => {});
    // A REFUSED send may be retried with the same key (nothing went out). An
    // unconfirmed one keeps the key, so the same compose cannot send it again.
    if (unconfirmed) await store.command(['SET', sendKey(idem), JSON.stringify({ state: 'UNCONFIRMED', user_id: me.user_id }), 'EX', 86400]).catch(() => {});
    else await store.command(['DEL', sendKey(idem)]).catch(() => {});
    return res.status(errorStatus(code)).json({ success: false, code, error: message, message_id: messageId });
  }
  const patch = { status: 'SENT', provider_message_id: sent.provider_message_id, provider_thread_id: sent.provider_thread_id, accepted_at: sent.accepted_at };
  await repo.updateById(EMAIL_MESSAGES_TAB, 'message_id', messageId, patch).catch((err) => console.error('mail-send: SENT but the audit row could not be patched', messageId, err?.message));
  const result = { ...row, ...patch };
  const publicResult = { message_id: messageId, status: 'SENT', provider: sent.provider, provider_status: 'ACCEPTED', provider_message_id: sent.provider_message_id, accepted_at: sent.accepted_at, from_email: account.email, to_email: row.to_email, subject };
  await store.command(['SET', sendKey(idem), JSON.stringify({ state: 'DONE', user_id: me.user_id, message: publicResult }), 'EX', 86400]).catch(() => {});
  await markAccount(me.user_id, { status: 'CONNECTED', last_sent_at: sent.accepted_at, last_error: '', last_error_at: '' }, { kv: store }).catch(() => {});
  // Emailing a prospect is a meaningful interaction: claims an unassigned lead.
  const ownership = agencyId && source !== 'TEST'
    ? await claimLeadIfUnassigned(repo, { agencyId, user: claimingUser(req), source: 'email', refId: messageId })
    : null;
  return res.status(201).json({ success: true, message: publicResult, ownership, row: { message_id: result.message_id, agency_id: agencyId } });
}

// ── templates ─────────────────────────────────────────────────────────────
async function readTemplates(repo, { seed = false, actor = '' } = {}) {
  let table;
  try { table = await repo.getTable(EMAIL_TEMPLATES_TAB); } catch { table = null; }
  if ((!table || !templateRecords(table).length) && seed) {
    // Seed the starter library once (a short Redis lock stops two first
    // loads from both seeding).
    let lock = 'OK';
    try { lock = await kvStore().command(['SET', seedLockKey, '1', 'NX', 'EX', 30]); } catch { lock = 'OK'; }
    if (lock === 'OK') {
      await repo.ensureTab(EMAIL_TEMPLATES_TAB, [...EMAIL_TEMPLATES_HEADER], noteRow(EMAIL_TEMPLATES_HEADER, EMAIL_TEMPLATES_SCHEMA_NOTE));
      const current = templateRecords(await repo.getTable(EMAIL_TEMPLATES_TAB));
      if (!current.length) {
        const now = new Date().toISOString();
        await repo.appendRowsBatch(EMAIL_TEMPLATES_TAB, STARTER_TEMPLATES.map((t) => rowFor(EMAIL_TEMPLATES_HEADER, {
          template_id: newTemplateId(), template_key: newTemplateKey(), name: t.name, purpose: t.purpose, version: 1, status: 'CURRENT',
          subject: t.subject, body: t.body, notes: 'Starter template', created_by: actor || 'system', created_at: now, updated_at: now, archived_at: '',
        })));
      }
    }
    // Someone else may hold the seed lock and not have created the tab yet:
    // that is an empty library for this read, not an error.
    try { table = await repo.getTable(EMAIL_TEMPLATES_TAB); } catch { table = null; }
  }
  return table ? templateRecords(table) : [];
}
async function sentTemplateCounts(repo) {
  const counts = new Map();
  for (const m of emailMessageRecords(await optionalTable(repo, EMAIL_MESSAGES_TAB))) {
    if (upper(m.status) !== 'SENT' || !text(m.template_id)) continue;
    counts.set(text(m.template_id), (counts.get(text(m.template_id)) || 0) + 1);
  }
  return counts;
}

export async function handleMailTemplates(req, res) {
  noStore(res);
  try {
    const repo = getRepo();
    const [rows, counts] = await Promise.all([readTemplates(repo, { seed: true, actor: req.novusUser?.user_id }), sentTemplateCounts(repo)]);
    return res.status(200).json({ success: true, purposes: TEMPLATE_PURPOSES, templates: templateLibrary(rows.map((r) => r.obj), counts) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not load templates' });
  }
}

export async function handleMailTemplateSave(req, res) {
  noStore(res);
  const b = req.body || {};
  if (text(b.confirm) !== 'SAVE_TEMPLATE') return res.status(400).json({ success: false, error: 'Missing confirm=SAVE_TEMPLATE' });
  const input = { name: text(b.name).slice(0, 120), purpose: upper(b.purpose), subject: text(b.subject).replace(/[\r\n]+/g, ' ').slice(0, 300), body: String(b.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000) };
  const problem = validateTemplate(input);
  if (problem) return res.status(400).json({ success: false, error: problem });
  const notes = text(b.notes).slice(0, 500);
  const status = upper(b.status);
  if (status && !TEMPLATE_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'invalid status' });
  try {
    const repo = getRepo();
    const rows = await readTemplates(repo, { seed: true, actor: req.novusUser?.user_id });
    const now = new Date().toISOString();
    const existing = text(b.template_id) ? rows.find((r) => text(r.obj.template_id) === text(b.template_id)) : null;
    if (text(b.template_id) && !existing) return res.status(404).json({ success: false, error: 'Template not found' });
    const used = existing ? ((await sentTemplateCounts(repo)).get(text(existing.obj.template_id)) || 0) : 0;
    const changed = existing && ['name', 'purpose', 'subject', 'body'].some((k) => text(input[k]) !== text(existing.obj[k]));
    const demote = async (key, exceptId) => {
      for (const r of rows) if (text(r.obj.template_key) === key && upper(r.obj.status) === 'CURRENT' && text(r.obj.template_id) !== exceptId) {
        await repo.updateById(EMAIL_TEMPLATES_TAB, 'template_id', text(r.obj.template_id), { status: 'ARCHIVED', archived_at: now, updated_at: now });
      }
    };
    let saved;
    if (!existing || (used > 0 && changed)) {
      const key = existing ? text(existing.obj.template_key) : newTemplateKey();
      const family = rows.filter((r) => text(r.obj.template_key) === key);
      const version = family.length ? Math.max(...family.map((r) => Number(r.obj.version) || 1)) + 1 : 1;
      const makeCurrent = status ? status === 'CURRENT' : true;
      saved = { template_id: newTemplateId(), template_key: key, ...input, version, status: makeCurrent ? 'CURRENT' : status || 'TESTING', notes, created_by: req.novusUser?.user_id || '', created_at: now, updated_at: now, archived_at: '' };
      if (makeCurrent) await demote(key, '');
      await repo.appendRowsBatch(EMAIL_TEMPLATES_TAB, [rowFor(EMAIL_TEMPLATES_HEADER, saved)]);
    } else {
      const patch = { ...input, notes, updated_at: now };
      if (status) { patch.status = status; patch.archived_at = status === 'ARCHIVED' ? now : ''; if (status === 'CURRENT') await demote(text(existing.obj.template_key), text(existing.obj.template_id)); }
      saved = await repo.updateById(EMAIL_TEMPLATES_TAB, 'template_id', text(existing.obj.template_id), patch);
    }
    return res.status(200).json({ success: true, template: saved, new_version: !existing || text(saved.template_id) !== text(existing?.obj.template_id), frozen_by_sends: used });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not save the template' });
  }
}

export async function handleMailTemplateStatus(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'SET_TEMPLATE_STATUS') return res.status(400).json({ success: false, error: 'Missing confirm=SET_TEMPLATE_STATUS' });
  const status = upper(req.body?.status);
  if (!TEMPLATE_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'invalid status' });
  try {
    const repo = getRepo();
    const rows = await readTemplates(repo);
    const target = rows.find((r) => text(r.obj.template_id) === text(req.body?.template_id));
    if (!target) return res.status(404).json({ success: false, error: 'Template not found' });
    const now = new Date().toISOString();
    if (status === 'CURRENT') {
      for (const r of rows) if (text(r.obj.template_key) === text(target.obj.template_key) && upper(r.obj.status) === 'CURRENT' && r !== target) {
        await repo.updateById(EMAIL_TEMPLATES_TAB, 'template_id', text(r.obj.template_id), { status: 'ARCHIVED', archived_at: now, updated_at: now });
      }
    }
    const saved = await repo.updateById(EMAIL_TEMPLATES_TAB, 'template_id', text(target.obj.template_id), { status, archived_at: status === 'ARCHIVED' ? now : '', updated_at: now });
    return res.status(200).json({ success: true, template: saved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not change the template status' });
  }
}

export async function handleMailTemplateDuplicate(req, res) {
  noStore(res);
  if (text(req.body?.confirm) !== 'DUPLICATE_TEMPLATE') return res.status(400).json({ success: false, error: 'Missing confirm=DUPLICATE_TEMPLATE' });
  try {
    const repo = getRepo();
    const rows = await readTemplates(repo);
    const source = rows.find((r) => text(r.obj.template_id) === text(req.body?.template_id));
    if (!source) return res.status(404).json({ success: false, error: 'Template not found' });
    const now = new Date().toISOString();
    const saved = { ...source.obj, template_id: newTemplateId(), template_key: newTemplateKey(), name: text(req.body?.name).slice(0, 120) || `${text(source.obj.name)} (copy)`, version: 1, status: 'CURRENT', notes: `Duplicated from ${text(source.obj.name)} v${text(source.obj.version)}`, created_by: req.novusUser?.user_id || '', created_at: now, updated_at: now, archived_at: '' };
    await repo.appendRowsBatch(EMAIL_TEMPLATES_TAB, [rowFor(EMAIL_TEMPLATES_HEADER, saved)]);
    return res.status(201).json({ success: true, template: saved });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || 'Could not duplicate the template' });
  }
}

export const _internal = { sendKey, optedOut, parseRecipients };
