// lib/lead-search.mjs — ONE lead lookup for the whole sales UI: the ⌘K global
// search, incoming-callback recognition, and anything later that needs to
// turn a phone number or a few typed characters into a lead (SMS matching,
// call history). Pure functions over already-loaded tables, plus one cached
// loader at the bottom.
//
// WHY ONE MODULE. The task rule is "global search and callbacks must use the
// same matching logic". So the index is built once (buildLeadIndex), the
// phone normaliser is the single definition of "same number" (normalizePhoneNumber),
// findLeadsByPhone is what the inbound webhook calls, and searchLeads is what
// the palette calls — and a phone typed into the palette goes through exactly
// the findLeadsByPhone path.
//
// WHERE NUMBERS COME FROM (existing fields only — nothing is added to any
// tab): every AGENCIES / CONTACTS column whose name contains phone/mobile/tel
// (same convention lib/inbound-matching.mjs agencyPhoneSet already relies on),
// referral numbers captured on a call (ACTIONS metadata_json.contact_override,
// CALLS.referred_contact_json) and the number actually dialled or received on
// every CALLS row. That last source is what lets a number Joe linked to a lead
// during an unknown-caller call match automatically next time, without
// writing anything to AGENCIES.
//
// RANKING IS DETERMINISTIC. rankPhoneMatches scores exact-number candidates by
// recency of the last outbound call, whether a callback is expected, and the
// latest activity — no AI, no guessing. It never merges or deletes records:
// several agencies on one switchboard number stay several candidates.

import { normalizePhone } from './normalize.mjs';
import { isDiscardedCall, liveCallRecords } from './calling-store.mjs';
import { parseActionRecords } from './actions-store.mjs';
import { CALL_ACTION_TYPES } from './acquisition-actions.mjs';
import { resolvePropertyStreet } from './property-reference.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const ts = (value) => (Number.isFinite(Date.parse(text(value))) ? Date.parse(text(value)) : null);
const ACTIVE = new Set(['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED']);
const CALLBACK_EXPECTED_OUTCOMES = new Set(['NO_ANSWER', 'OWNER_UNAVAILABLE', 'CALLBACK_REQUESTED', 'GATEKEPT', 'MORE_INFO_REQUESTED']);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── phone normalisation ────────────────────────────────────────────────────
// The single definition of "the same number". Builds on lib/normalize.mjs's
// normalizePhone (0… → +44…) and adds the forms it does not handle:
// international 00 prefix, "+44 (0)7…", extensions, and a bare national
// number typed without its leading zero. Returns E.164 or '' when the input
// is not a plausible number. The human-readable number is never touched —
// callers keep the raw string for display and use this only for matching.
export function normalizePhoneNumber(raw) {
  let value = text(raw);
  if (!value) return '';
  value = value.replace(/\b(?:ext|extension|x)\.?\s*\d{1,5}\s*$/i, '');
  value = value.replace(/^\+?\s*44\s*\(\s*0\s*\)\s*/, '+44');
  value = value.replace(/^00\s*/, '+');
  let digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = `+${digits.slice(1).replace(/\+/g, '')}`;
  else digits = digits.replace(/\+/g, '');
  const bare = digits.replace(/^\+/, '');
  if (!bare) return '';
  let e164;
  if (digits.startsWith('+')) e164 = digits;
  else if (digits.startsWith('0')) e164 = normalizePhone(digits);
  else if (bare.startsWith('44') && bare.length >= 12) e164 = `+${bare}`;
  else if (bare.length === 10) e164 = `+44${bare}`; // 7700 900123 typed without the 0
  else e164 = `+${bare}`;
  const count = e164.replace(/^\+/, '').length;
  if (count < 7 || count > 15) return '';
  return e164;
}

// Digits only, for partial ("contains / ends with") matching of a number
// someone is still typing. A UK national form is folded onto its +44 form
// so "01277 123" and "+44 1277 123" are the same prefix.
export function phoneDigits(raw) {
  const value = text(raw).replace(/^\+?\s*44\s*\(\s*0\s*\)\s*/, '+44').replace(/^00/, '+');
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  if (value.trim().startsWith('+')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

export function looksLikePhone(query) {
  const value = text(query);
  if (!value) return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 && !/[a-z]/i.test(value.replace(/\b(?:ext|x)\b/gi, ''));
}

// Human-friendly UK formatting for a number we only hold in E.164 (the
// inbound caller id). Stored numbers are always shown exactly as stored.
export function formatPhoneForDisplay(e164) {
  const value = text(e164);
  if (!/^\+44\d{9,10}$/.test(value)) return value;
  const national = `0${value.slice(3)}`;
  if (/^07/.test(national) && national.length === 11) return `${national.slice(0, 5)} ${national.slice(5)}`;
  if (/^0(20|23|24|28|29)/.test(national) && national.length === 11) return `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
  if (national.length === 11) return `${national.slice(0, 5)} ${national.slice(5)}`;
  if (national.length === 10) return `${national.slice(0, 4)} ${national.slice(4)}`;
  return national;
}

// ── index ──────────────────────────────────────────────────────────────────
function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))];
  });
}
function group(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const value = text(row[key]);
    if (!value) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
}
function metadata(row) {
  try { return JSON.parse(text(row?.metadata_json) || '{}'); } catch { return {}; }
}
function splitList(cell) {
  return text(cell).split(/[,;|/\n]+/).map(text).filter(Boolean);
}
const PHONE_COLUMN = /phone|mobile|tel\b|telephone|switchboard/i;
function phoneCells(row) {
  const out = [];
  for (const [key, value] of Object.entries(row || {})) {
    if (!PHONE_COLUMN.test(key) || !text(value)) continue;
    for (const raw of splitList(value)) {
      const e164 = normalizePhoneNumber(raw);
      if (e164) out.push({ raw, e164, column: key });
    }
  }
  return out;
}
function domainOf(value) {
  const v = text(value).toLowerCase();
  if (!v) return '';
  const at = v.indexOf('@');
  if (at >= 0) return v.slice(at + 1);
  return v.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
}
export function foldText(value) {
  return text(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9@.+]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const relative = (ms, nowMs) => {
  const diff = nowMs - ms;
  if (!Number.isFinite(diff)) return '';
  if (diff < 90_000) return 'just now';
  if (diff < HOUR) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 30 * DAY) return `${Math.round(diff / DAY)}d ago`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const OUTCOME_WORDS = {
  NO_ANSWER: 'no answer', GATEKEPT: 'gatekept', OWNER_UNAVAILABLE: 'owner unavailable', CALLBACK_REQUESTED: 'callback requested',
  MORE_INFO_REQUESTED: 'more info requested', NOT_INTERESTED: 'not interested', BOOKED_MEETING: 'meeting booked', WRONG_NUMBER: 'wrong number',
  NOT_THE_DECISION_MAKER: 'not the decision-maker', DO_NOT_CALL: 'do not call', REFERRED_TO_EMAIL: 'referred to email',
};
export function callDirection(row) { return upper(metadata(row).direction) === 'INBOUND' ? 'INBOUND' : 'OUTBOUND'; }
function inboundResult(row) { return text(metadata(row).inbound?.result); }

// One entry per AGENCIES row (a "lead" in the UI's sense). Nothing is
// merged: two imported rows for the same office stay two entries.
export function buildLeadIndex(tables, { now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now) || Date.now();
  const agencies = records(tables.AGENCIES, 'agency_id');
  const contactsByAgency = group(records(tables.CONTACTS, 'contact_id'), 'agency_id');
  const probesByAgency = group(records(tables.PROBES, 'probe_id'), 'agency_id');
  const callsByAgency = group(liveCallRecords(tables.CALLS), 'agency_id');
  const actionsByAgency = group(parseActionRecords(tables.ACTIONS).map((r) => r.obj), 'agency_id');
  const intelByAgency = group(records(tables.INTELLIGENCE, 'intelligence_id'), 'agency_id');
  const diagnosisByAgency = group(records(tables.DIAGNOSIS, 'diagnosis_id'), 'agency_id');
  const latest = (rows, key) => [...(rows || [])].sort((a, b) => (ts(b[key]) ?? 0) - (ts(a[key]) ?? 0))[0] || null;

  return agencies.map((agency) => {
    const agencyId = text(agency.agency_id);
    const contacts = (contactsByAgency.get(agencyId) || []).map((row) => ({
      contact_id: text(row.contact_id), name: text(row.contact_name), role: text(row.contact_role),
      email: text(row.email || row.contact_email), selected: upper(row.is_selected_for_outreach) === 'TRUE', phones: phoneCells(row),
    }));
    const selected = contacts.find((c) => c.selected) || null;
    const calls = [...(callsByAgency.get(agencyId) || [])].sort((a, b) => (ts(b.started_at) ?? 0) - (ts(a.started_at) ?? 0));
    const actions = actionsByAgency.get(agencyId) || [];
    const activeCallActions = actions.filter((row) => CALL_ACTION_TYPES.includes(upper(row.action_type)) && ACTIVE.has(upper(row.action_status)))
      .sort((a, b) => (ts(a.due_at) ?? Infinity) - (ts(b.due_at) ?? Infinity));
    const override = activeCallActions.map((row) => metadata(row).contact_override).find((ref) => ref && (text(ref.phone) || text(ref.name))) || null;

    // Every number that can identify this lead, with where it came from.
    const phones = [];
    const seen = new Set();
    const addPhone = (entry, source, contact) => {
      if (!entry?.e164 || seen.has(`${entry.e164}|${text(contact?.name)}`)) return;
      seen.add(`${entry.e164}|${text(contact?.name)}`);
      phones.push({ raw: entry.raw, e164: entry.e164, source, contact_name: text(contact?.name), contact_role: text(contact?.role) });
    };
    for (const cell of phoneCells(agency)) addPhone(cell, cell.column === 'main_phone' ? 'AGENCY_MAIN' : 'AGENCY', null);
    for (const contact of contacts) for (const cell of contact.phones) addPhone(cell, 'CONTACT', contact);
    for (const action of actions) {
      const ref = metadata(action).contact_override;
      if (ref && text(ref.phone)) addPhone({ raw: text(ref.phone), e164: normalizePhoneNumber(ref.phone) }, 'REFERRAL', ref);
    }
    for (const call of calls) {
      let referred = null;
      try { referred = JSON.parse(text(call.referred_contact_json) || 'null'); } catch { referred = null; }
      if (referred && text(referred.phone)) addPhone({ raw: text(referred.phone), e164: normalizePhoneNumber(referred.phone) }, 'REFERRAL', referred);
      if (text(call.phone)) addPhone({ raw: text(call.phone), e164: normalizePhoneNumber(call.phone) }, callDirection(call) === 'INBOUND' ? 'INBOUND_CALL' : 'CALL', { name: text(call.contact_name), role: text(call.contact_role) });
    }

    const contactName = text(override?.name) || text(agency.outreach_contact_name || agency.primary_contact_name) || text(selected?.name);
    const contactRole = text(override?.role) || text(selected?.role) || text(contacts.find((c) => c.name && c.name === contactName)?.role);
    const displayPhone = text(override?.phone) || text(agency.main_phone) || phones[0]?.raw || '';

    const probes = [...(probesByAgency.get(agencyId) || [])].sort((a, b) => (ts(b.probe_timestamp) ?? ts(b.created_at) ?? 0) - (ts(a.probe_timestamp) ?? ts(a.created_at) ?? 0));
    const genuine = probes.find((row) => ['OBSERVING', 'ACTIVE', 'CLOSED'].includes(upper(row.probe_status))) || probes[0] || null;
    const properties = probes.map((row) => ({
      probe_id: text(row.probe_id), address: text(row.property_address), street: resolvePropertyStreet(row),
      enquiry_text: text(row.enquiry_text), sent_at: text(row.probe_timestamp), status: text(row.probe_status),
    }));

    const classified = calls.filter((row) => text(row.outcome));
    // A callback still ringing is this very moment, not the lead's last
    // activity — the overlay must say "called 45 min ago", not "ringing".
    const settled = calls.filter((row) => !(callDirection(row) === 'INBOUND' && upper(row.call_status) === 'RINGING' && !text(row.connected_at) && !inboundResult(row)));
    const lastCall = settled[0] || null;
    const lastClassified = classified[0] || null;
    const lastOutbound = calls.find((row) => callDirection(row) === 'OUTBOUND' && (text(row.outcome) || text(row.connected_at) || text(row.started_at))) || null;
    const callLabel = (row) => {
      if (!row) return '';
      const at = ts(row.started_at);
      const when = at !== null ? relative(at, nowMs) : '';
      if (callDirection(row) === 'INBOUND') {
        const result = inboundResult(row);
        const what = text(row.outcome) ? OUTCOME_WORDS[upper(row.outcome)] || text(row.outcome).toLowerCase() : (result === 'answered' || text(row.connected_at) ? 'answered' : result === 'declined' ? 'declined' : result ? 'missed' : 'ringing');
        return `Called back ${when} · ${what}`;
      }
      const what = text(row.outcome) ? OUTCOME_WORDS[upper(row.outcome)] || text(row.outcome).toLowerCase() : 'not logged';
      return `Called ${when} · ${what}`;
    };
    let lastActivity = null;
    if (lastCall) lastActivity = { at: text(lastCall.started_at), label: callLabel(lastCall), kind: 'call' };
    else if (genuine && text(genuine.probe_timestamp)) lastActivity = { at: text(genuine.probe_timestamp), label: `Probe sent ${relative(ts(genuine.probe_timestamp), nowMs)}`, kind: 'probe' };

    const intel = latest(intelByAgency.get(agencyId), 'updated_at');
    const diagnosis = latest(diagnosisByAgency.get(agencyId), 'updated_at');
    const summary = text(diagnosis?.handling_summary || diagnosis?.diagnosis_summary || intel?.grade_reason).slice(0, 240);
    const website = text(agency.website);
    const domain = text(agency.domain) || domainOf(website) || domainOf(agency.outreach_contact_email || agency.primary_contact_email);
    const email = text(agency.outreach_contact_email || agency.primary_contact_email);
    const dueAction = activeCallActions[0] || null;

    const entry = {
      agency_id: agencyId,
      agency_name: text(agency.clean_agency_name || agency.agency_name),
      contact_name: contactName, contact_role: contactRole,
      phone: displayPhone, phone_e164: normalizePhoneNumber(displayPhone), phones,
      email, website, domain,
      location: text(agency.location),
      pipeline_status: text(agency.current_pipeline_status),
      suppression_status: text(agency.suppression_status),
      contacts,
      property: genuine ? (resolvePropertyStreet(genuine) || text(genuine.property_address)) : '',
      property_address: text(genuine?.property_address),
      properties,
      summary,
      probe_grade: text(intel?.grade),
      last_call: lastCall ? { call_id: text(lastCall.call_id), at: text(lastCall.started_at), outcome: text(lastCall.outcome), direction: callDirection(lastCall), connected: upper(lastCall.connected) === 'TRUE' || Boolean(text(lastCall.connected_at)), label: callLabel(lastCall) } : null,
      last_outbound_at: text(lastOutbound?.started_at),
      last_outbound_outcome: text(lastOutbound?.outcome),
      callback_expected: Boolean(lastClassified && CALLBACK_EXPECTED_OUTCOMES.has(upper(lastClassified.outcome))) || activeCallActions.length > 0,
      call_action_due_at: text(dueAction?.due_at),
      last_activity: lastActivity,
      attempts: classified.length,
    };
    entry.blob = foldText([
      entry.agency_name, text(agency.agency_name), contactName, contactRole, email, website, domain, entry.location, agencyId,
      ...contacts.flatMap((c) => [c.name, c.role, c.email]),
      ...properties.flatMap((p) => [p.address, p.street]),
    ].filter(Boolean).join(' | '));
    entry.enquiry_blob = foldText(properties.map((p) => p.enquiry_text).filter(Boolean).join(' | '));
    return entry;
  });
}

// What the UI shows for a lead — the same shape in the palette rows, the
// incoming overlay and the "link to lead" picker.
export function leadSummary(entry) {
  return {
    agency_id: entry.agency_id, agency_name: entry.agency_name,
    contact_name: entry.contact_name, contact_role: entry.contact_role,
    phone: entry.phone, phone_e164: entry.phone_e164, email: entry.email, location: entry.location,
    property: entry.property, property_address: entry.property_address,
    pipeline_status: entry.pipeline_status, summary: entry.summary, probe_grade: entry.probe_grade,
    last_activity: entry.last_activity, last_call: entry.last_call, attempts: entry.attempts,
    callback_expected: entry.callback_expected, call_action_due_at: entry.call_action_due_at,
  };
}

// ── phone lookup ───────────────────────────────────────────────────────────
// Every lead holding exactly this number (E.164 equality after
// normalisation). One match per (agency, contact) the number belongs to, so
// a switchboard number shared by two contacts of one agency is one agency
// with two possible contacts, and the same number on two imported agency
// rows is two candidates.
export function findLeadsByPhone(index, number) {
  const e164 = normalizePhoneNumber(number);
  if (!e164) return [];
  const out = [];
  for (const entry of index) {
    const hits = entry.phones.filter((p) => p.e164 === e164);
    if (!hits.length) continue;
    const specific = hits.find((p) => p.source === 'CONTACT' || p.source === 'REFERRAL');
    const hit = specific || hits[0];
    out.push({
      ...leadSummary(entry),
      contact_name: text(hit.contact_name) || entry.contact_name,
      contact_role: text(hit.contact_name) ? text(hit.contact_role) : entry.contact_role,
      matched_number: hit.raw, matched_source: hit.source,
      matched_sources: [...new Set(hits.map((p) => p.source))],
      _entry: entry,
    });
  }
  return out;
}

// Deterministic ranking + a "preselect the obvious one" verdict.
// Signals, strongest first: the most recent OUTBOUND call to the lead
// (45 minutes ago beats yesterday beats last week), a callback expected from
// the last outcome or an active call action, the number being a specific
// contact's rather than the office line, latest activity as the tie-break.
export function rankPhoneMatches(matches, { nowMs = Date.now() } = {}) {
  const scored = matches.map((m) => {
    const entry = m._entry || m;
    let score = 10;
    const reasons = [];
    const lastOut = ts(entry.last_outbound_at);
    if (lastOut !== null) {
      const age = nowMs - lastOut;
      const outcome = OUTCOME_WORDS[upper(entry.last_outbound_outcome)] || text(entry.last_outbound_outcome).toLowerCase() || 'call';
      if (age <= HOUR) { score += 60; reasons.push(`Called ${relative(lastOut, nowMs)} · ${outcome}`); }
      else if (age <= DAY) { score += 40; reasons.push(`Called ${relative(lastOut, nowMs)} · ${outcome}`); }
      else if (age <= 7 * DAY) { score += 20; reasons.push(`Called ${relative(lastOut, nowMs)} · ${outcome}`); }
      else { score += 5; reasons.push(`Last called ${relative(lastOut, nowMs)}`); }
    }
    if (entry.callback_expected) { score += 10; reasons.push('Callback expected'); }
    if (m.matched_source === 'CONTACT' || m.matched_source === 'REFERRAL') { score += 5; reasons.push(`${m.contact_name || 'Contact'}'s number`); }
    if (m.matched_source === 'INBOUND_CALL') { score += 4; reasons.push('Called from this number before'); }
    const activity = ts(entry.last_activity?.at);
    if (activity !== null) score += Math.max(0, 3 - Math.min(3, (nowMs - activity) / (30 * DAY)));
    const { _entry, ...rest } = m;
    return { ...rest, score: Math.round(score * 100) / 100, reasons };
  });
  scored.sort((a, b) => b.score - a.score || text(a.agency_name).localeCompare(text(b.agency_name)));
  const top = scored[0];
  if (top) {
    const second = scored[1];
    top.preselected = !second || top.score - second.score >= 20;
  }
  return scored;
}

// ── free-text search ───────────────────────────────────────────────────────
// Partial, case/punctuation-insensitive, all typed words must match somewhere
// on the lead. A query that looks like a phone number goes through the phone
// path instead: exact E.164 match first, then "ends with / contains" on the
// digits so a half-typed number already narrows the list.
export function searchLeads(index, query, { limit = 12, nowMs = Date.now() } = {}) {
  const raw = text(query);
  if (!raw) return [];
  if (looksLikePhone(raw)) {
    const exact = rankPhoneMatches(findLeadsByPhone(index, raw), { nowMs }).map((m) => ({ ...m, matched_on: ['phone'], score: m.score + 100 }));
    const digits = phoneDigits(raw);
    const seen = new Set(exact.map((m) => m.agency_id));
    const partial = [];
    if (digits.length >= 4) {
      for (const entry of index) {
        if (seen.has(entry.agency_id)) continue;
        const hit = entry.phones.find((p) => p.e164.slice(1).endsWith(digits) || p.e164.slice(1).includes(digits));
        if (!hit) continue;
        partial.push({ ...leadSummary(entry), contact_name: text(hit.contact_name) || entry.contact_name, matched_number: hit.raw, matched_source: hit.source, matched_on: ['phone'], score: p164Score(hit.e164, digits), reasons: [] });
      }
      partial.sort((a, b) => b.score - a.score || text(a.agency_name).localeCompare(text(b.agency_name)));
    }
    return [...exact, ...partial].slice(0, limit);
  }

  const folded = foldText(raw);
  const tokens = folded.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const results = [];
  for (const entry of index) {
    let score = 0;
    const matchedOn = new Set();
    let all = true;
    for (const token of tokens) {
      let best = 0;
      const check = (field, value, weight) => {
        const v = foldText(value);
        if (!v) return;
        let s = 0;
        if (v === token) s = weight * 3;
        else if (v.startsWith(token)) s = weight * 2;
        else if (v.split(' ').some((w) => w.startsWith(token))) s = weight * 1.5;
        else if (v.includes(token)) s = weight;
        if (s > best) { best = s; matchedOn.add(field); }
      };
      check('agency', entry.agency_name, 10);
      check('id', entry.agency_id, 10);
      check('contact', entry.contact_name, 8);
      for (const c of entry.contacts) { check('contact', c.name, 7); check('contact', c.email, 5); }
      check('email', entry.email, 6);
      check('domain', entry.domain, 6);
      check('website', entry.website, 5);
      check('location', entry.location, 5);
      for (const p of entry.properties) { check('property', p.address, 5); check('property', p.street, 5); }
      if (!best && token.length >= 4 && entry.enquiry_blob.includes(token)) { best = 1; matchedOn.add('enquiry'); }
      if (!best && token.length >= 3 && entry.blob.includes(token)) { best = 0.5; }
      if (!best) { all = false; break; }
      score += best;
    }
    if (!all) continue;
    // Phrase bonus: the words typed in this order, e.g. "church hawes".
    if (tokens.length > 1 && entry.blob.includes(tokens.join(' '))) score += 5;
    results.push({ ...leadSummary(entry), matched_on: [...matchedOn], score: Math.round(score * 100) / 100 });
  }
  results.sort((a, b) => b.score - a.score || text(a.agency_name).localeCompare(text(b.agency_name)));
  return results.slice(0, limit);
}
function p164Score(e164, digits) {
  const bare = e164.slice(1);
  return bare.endsWith(digits) ? 50 + digits.length : 20 + digits.length;
}

// ── loader (Sheets) ────────────────────────────────────────────────────────
// Seven tab reads in parallel, cached in-process for 30s: the palette is
// called on every keystroke and must never pay for a Sheets round-trip per
// character. Missing optional tabs (CONTACTS, DIAGNOSIS, …) are empty, not
// errors. Every calling write clears it (invalidateLeadIndex), the same way
// the workspace cache is cleared.
export const LEAD_INDEX_TABS = Object.freeze(['AGENCIES', 'CONTACTS', 'PROBES', 'CALLS', 'ACTIONS', 'INTELLIGENCE', 'DIAGNOSIS']);
const INDEX_TTL_MS = 30_000;
let indexCache = null;
export function invalidateLeadIndex() { indexCache = null; }
export async function loadLeadIndex(repo, { refresh = false, now = new Date().toISOString() } = {}) {
  const nowMs = Date.now();
  if (!refresh && indexCache && nowMs - indexCache.at < INDEX_TTL_MS) return indexCache.index;
  const entries = await Promise.all(LEAD_INDEX_TABS.map(async (tab) => {
    try { return [tab, await repo.getTable(tab)]; }
    catch (err) {
      if (tab === 'AGENCIES') throw err;
      return [tab, { header: [], rows: [] }];
    }
  }));
  const index = buildLeadIndex(Object.fromEntries(entries), { now });
  indexCache = { at: Date.now(), index };
  return index;
}

export const _internal = { records, group, metadata, phoneCells, domainOf, relative, callLabelFor: OUTCOME_WORDS };
