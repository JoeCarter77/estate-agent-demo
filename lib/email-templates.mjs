// lib/email-templates.mjs — the shared library of one-to-one email
// templates (EMAIL_TEMPLATES tab), versioned exactly like SCRIPTS:
//
//   · ONE ROW PER VERSION. template_key groups the versions of one template.
//   · Each template has one CURRENT version — the one offered in compose.
//     TESTING versions can be picked explicitly; ARCHIVED are history.
//   · A version that a sent email used (EMAIL_MESSAGES.template_id) is
//     frozen: editing it creates the next version, so every sent email keeps
//     pointing at the wording it started from.
//
// A template is only a starting point: the person sees and edits the final
// subject and body before anything is sent (lib/mail-handlers.mjs). Nothing
// here sends, and no template is ever sent automatically.
//
// Placeholders (filled in the compose window from the lead and the sender):
//   {{first_name}} {{name}} {{agency}} {{location}} {{property}}
//   {{sender_name}} {{sender_first_name}} {{sender_email}}
//   {{meeting_time}} {{callback_time}}

import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();

export const EMAIL_TEMPLATES_TAB = 'EMAIL_TEMPLATES';
export const EMAIL_TEMPLATES_HEADER = Object.freeze([
  'template_id', 'template_key', 'name', 'purpose', 'version', 'status', 'subject', 'body', 'notes',
  'created_by', 'created_at', 'updated_at', 'archived_at',
]);
export const EMAIL_TEMPLATES_SCHEMA_NOTE = 'One row per email template VERSION. template_key groups versions; one CURRENT version per template is offered in compose. A version used by a sent email (EMAIL_MESSAGES.template_id) is frozen — editing creates the next version. Manage from Settings → Email templates.';
export const TEMPLATE_STATUSES = Object.freeze(['CURRENT', 'TESTING', 'ARCHIVED']);

// What the template is for — Calling Mode suggests the matching ones.
export const TEMPLATE_PURPOSES = Object.freeze({
  MORE_INFO: 'Prospect asked for more information',
  GATEKEEPER_REFERRAL: 'Gatekeeper asked us to email',
  DECISION_MAKER_FOLLOW_UP: 'Decision-maker follow-up',
  MEETING_CONFIRMATION: 'Meeting confirmation',
  CALLBACK_INFO: 'Before a callback',
  GENERAL: 'General',
});
// Call outcome → the template purpose to suggest first.
export const OUTCOME_PURPOSE = Object.freeze({
  MORE_INFO_REQUESTED: 'MORE_INFO', REFERRED_TO_EMAIL: 'GATEKEEPER_REFERRAL', BOOKED_MEETING: 'MEETING_CONFIRMATION',
  CALLBACK_REQUESTED: 'CALLBACK_INFO', OWNER_UNAVAILABLE: 'CALLBACK_INFO', NOT_THE_DECISION_MAKER: 'GATEKEEPER_REFERRAL',
});

export const PLACEHOLDERS = Object.freeze(['first_name', 'name', 'agency', 'location', 'property', 'sender_name', 'sender_first_name', 'sender_email', 'meeting_time', 'callback_time']);

// Starter library, written once into an empty tab (seedTemplatesIfEmpty).
// Deliberately price-free: the offer changes; admins edit these in Settings.
export const STARTER_TEMPLATES = Object.freeze([
  { name: 'More information after a call', purpose: 'MORE_INFO', subject: 'Following our call — NOVUS for {{agency}}',
    body: 'Hi {{first_name}},\n\nThanks for your time on the phone just now. As promised, here is a short overview of what NOVUS does for independent agents like {{agency}}.\n\nIn short: we look at how enquiries and existing contacts are followed up, find where valuation opportunities are being missed, and put a simple process in place so more of them turn into instructions.\n\nIf it would help, I can walk you through what we found for agents in {{location}} in a 20-minute call — just reply with a time that suits.\n\nBest regards,\n{{sender_name}}' },
  { name: 'Gatekeeper asked for an email', purpose: 'GATEKEEPER_REFERRAL', subject: 'For {{first_name}} — quick note from NOVUS',
    body: 'Hi {{first_name}},\n\nI spoke to a colleague of yours at {{agency}} earlier, who suggested email was the best way to reach you.\n\nI work with independent agents on turning more of their existing enquiries and contacts into valuations. I\'d value two minutes to explain how — is there a good time this week for a quick call?\n\nBest regards,\n{{sender_name}}' },
  { name: 'Decision-maker follow-up', purpose: 'DECISION_MAKER_FOLLOW_UP', subject: 'Next step for {{agency}}',
    body: 'Hi {{first_name}},\n\nGood to speak earlier. To recap the next step we agreed: \n\n[edit this line]\n\nIf anything changes on your side, just reply to this email.\n\nBest regards,\n{{sender_name}}' },
  { name: 'Meeting confirmation', purpose: 'MEETING_CONFIRMATION', subject: 'Confirmed: NOVUS call {{meeting_time}}',
    body: 'Hi {{first_name}},\n\nThanks for making the time — this confirms our call on {{meeting_time}}.\n\nWe\'ll spend about 30 minutes on how {{agency}} handles new enquiries and past contacts today, and where the quickest wins are. Nothing to prepare.\n\nIf the time stops working, just reply and we\'ll move it.\n\nBest regards,\n{{sender_name}}' },
  { name: 'Before a callback', purpose: 'CALLBACK_INFO', subject: 'Ahead of our call {{callback_time}}',
    body: 'Hi {{first_name}},\n\nAs mentioned, I\'ll call you back on {{callback_time}}. In the meantime, here is a little background on NOVUS so the call can be quick.\n\nWe help independent agents get more valuations from the enquiries and contacts they already have.\n\nSpeak soon,\n{{sender_name}}' },
]);

export function newTemplateId() { return `tpl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`; }
export function newTemplateKey() { return `tk_${crypto.randomBytes(4).toString('hex')}`; }

export function templateRecords(table) {
  const header = table?.header || [];
  const at = header.indexOf('template_id');
  if (at < 0) return [];
  return (table.rows || []).flatMap((row, index) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])) }];
  });
}

export function validateTemplate({ name, purpose, subject, body }) {
  if (!text(name)) return 'Give the template a name.';
  if (!(upper(purpose) in TEMPLATE_PURPOSES)) return 'Choose what the template is for.';
  if (!text(subject)) return 'The subject cannot be empty.';
  if (!text(body)) return 'The body cannot be empty.';
  const unknown = [...`${subject} ${body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !PLACEHOLDERS.includes(k));
  if (unknown.length) return `Unknown placeholder: {{${unknown[0]}}}. Use: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}`;
  return '';
}

// Templates grouped for the page: one entry per template_key with its
// CURRENT (or newest) version first and every version listed.
export function templateLibrary(rows, usedCounts = new Map()) {
  const byKey = new Map();
  for (const row of rows) {
    const key = text(row.template_key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...row, version: Number(row.version) || 1, status: upper(row.status), purpose: upper(row.purpose), sent_count: usedCounts.get(text(row.template_id)) || 0 });
  }
  return [...byKey.entries()].map(([key, versions]) => {
    versions.sort((a, b) => b.version - a.version);
    const current = versions.find((v) => v.status === 'CURRENT') || versions.find((v) => v.status !== 'ARCHIVED') || null;
    return { template_key: key, name: text(current?.name || versions[0].name), purpose: text(current?.purpose || versions[0].purpose), current_id: text(current?.template_id), archived: !current, versions };
  }).sort((a, b) => Number(a.archived) - Number(b.archived) || a.purpose.localeCompare(b.purpose) || a.name.localeCompare(b.name));
}

export function rowFor(header, obj) { return header.map((key) => obj[key] ?? ''); }
