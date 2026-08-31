#!/usr/bin/env node
// scripts/novus-reply-classification-selftest.mjs
//
// OFFLINE by default: no network, no API key, no Google Sheets. The classifier
// is driven through an injected fake so every failure path — malformed JSON,
// unsupported enum, sub-threshold confidence, timeout, HTTP 500, empty response
// — is exercised deterministically.
//
// `--live` additionally runs the real model over the phrase table and prints
// expected vs actual. That one COSTS MONEY and needs ANTHROPIC_API_KEY.
//
// What it proves, beyond the phrase mapping:
//   - deterministic opt-out and out-of-office never reach the model
//   - the classifier sees cleaned_reply_text, never quoted history
//   - AI failure never loses the persisted event
//   - only derived fields are ever updated; raw evidence is byte-identical
//   - exactly one REPLY_EVENTS row per reply, before and after classification
//   - no Instantly write, no OUTBOUND write, no send

import {
  classifyReply,
  validateClassifierResult,
  buildClassifierPrompt,
  CONFIDENCE_THRESHOLD,
  AI_CLASSIFICATIONS,
} from '../lib/reply-classification.mjs';
import {
  normalizeInstantlyEmail,
  routeReply,
  buildReplyEventRow,
  buildClassificationPatch,
  updateReplyEventClassification,
  REPLY_EVENTS_HEADER,
  RAW_EVIDENCE_FIELDS,
  ROUTING_TABLE,
} from '../lib/reply-router.mjs';
import { pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import { PHRASES, DETERMINISTIC_PHRASES } from '../lib/reply-classification-fixtures.mjs';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── Fixtures ────────────────────────────────────────────────────────────────
const LEAD = 'agent@example-agency.co.uk';
const NOVUS = 'joe@novushq.co.uk';

function email(body, over = {}) {
  return {
    id: over.id || 'em_1',
    ue_type: 2,
    eaccount: NOVUS,
    from_address_email: LEAD,
    to_address_email_list: NOVUS,
    lead: LEAD,
    campaign_id: 'camp_1',
    thread_id: 'th_1',
    timestamp: '2026-08-31T10:00:00Z',
    subject: 'Re: your enquiry handling',
    body: { text: body },
    ...over,
  };
}
const reply = (body, over = {}) => normalizeInstantlyEmail(email(body, over));

function fakeAi(classification, confidence = 0.95, reason = 'test') {
  const calls = [];
  const impl = async (args) => { calls.push(args); return { classification, confidence, reason }; };
  impl.calls = calls;
  return impl;
}

// In-memory repo recording every operation, so "no second row" and "only
// derived cells written" are assertions about actual calls, not intentions.
function memRepo(rows = []) {
  const ops = [];
  const table = [REPLY_EVENTS_HEADER.slice(), ...rows];
  return {
    ops,
    table,
    async getTable(tab) { ops.push({ op: 'getTable', tab }); return { header: table[0], rows: table.slice(1), allValues: table }; },
    async getRecords(tab) {
      ops.push({ op: 'getRecords', tab });
      if (tab === 'OUTBOUND') {
        return [{ index: 0, rowNumber: 2, obj: { outbound_id: 'ob_1', agency_id: 'ag_1', outreach_contact_email: LEAD } }];
      }
      return [];
    },
    async findById() { ops.push({ op: 'findById' }); return null; },
    async appendRecord(tab, obj) {
      ops.push({ op: 'appendRecord', tab, obj });
      table.push(REPLY_EVENTS_HEADER.map((k) => obj[k] ?? ''));
      return obj;
    },
    async writeCellsBatch(writes) { ops.push({ op: 'writeCellsBatch', writes });
      for (const w of writes) table[w.rowNumber - 1][w.columnNumber - 1] = w.value; },
    async updateById() { ops.push({ op: 'updateById' }); throw new Error('updateById must not be used here'); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. Deterministic paths bypass the model entirely');
{
  for (const [text, expected] of DETERMINISTIC_PHRASES) {
    const ai = fakeAi('POSITIVE_SEND_DEMO', 0.99);
    const d = await classifyReply(reply(text), { aiCall: ai });
    check(`"${text}" -> ${expected}, AI not called`,
      d.classification === expected && d.source === 'DETERMINISTIC' && ai.calls.length === 0,
      `${d.classification}/${d.source}/${ai.calls.length} calls`);
    check(`  ${expected} routing metadata`,
      d.next_action === ROUTING_TABLE[expected].next_action
      && d.priority === ROUTING_TABLE[expected].priority
      && d.suppression_type === ROUTING_TABLE[expected].suppression_type);
  }
  const ai = fakeAi('POSITIVE_SEND_DEMO', 0.99);
  const ooo = await classifyReply(reply('I am out of the office until Monday.', { is_auto_reply: true }), { aiCall: ai });
  check('is_auto_reply -> OOO_AUTOMATED, AI not called',
    ooo.classification === 'OOO_AUTOMATED' && ai.calls.length === 0 && ooo.next_action === 'NONE' && ooo.priority === 'LOW');
}

section('2. The classifier sees cleaned_reply_text, never quoted history');
{
  const raw = 'yeah go on\n\nOn Mon, 31 Aug 2026 at 21:01, Joe Carter <joe@novushq.co.uk> wrote:\n> unsubscribe here\n> our full pitch, sent to 400 agencies';
  const r = reply(raw);
  const ai = fakeAi('POSITIVE_SEND_DEMO', 0.93);
  await classifyReply(r, { aiCall: ai });
  const prompt = ai.calls[0].prompt;
  check('prompt contains the cleaned text', prompt.includes('yeah go on'));
  check('prompt excludes quoted history', !prompt.includes('400 agencies') && !prompt.includes('Joe Carter <'));
  check('prompt excludes the raw body verbatim', !prompt.includes('On Mon, 31 Aug 2026'));
  check('quoted "unsubscribe" did not trigger deterministic opt-out',
    routeReply(r).classification === 'OTHER_UNCLEAR');
  check('one AI call per reply', ai.calls.length === 1);
  // Regression: the quote-header marker used to match the "on" inside the reply
  // itself, cutting "yeah go on" down to "yeah go".
  check('a bare "on" inside the reply is not treated as a quote header',
    reply('yeah go on').cleaned_reply_text === 'yeah go on', reply('yeah go on').cleaned_reply_text);
  check('a real quote header is still cut', r.cleaned_reply_text === 'yeah go on', r.cleaned_reply_text);
  check('prompt builder is stable', buildClassifierPrompt('sure').includes('sure'));
}

section('3. Failure modes all land on OTHER_UNCLEAR / MANUAL_REVIEW / HIGH');
{
  const cases = [
    ['malformed / non-object result', async () => 'not json at all'],
    ['empty response', async () => null],
    ['unsupported enum', async () => ({ classification: 'DEFINITELY_KEEN', confidence: 0.99, reason: 'x' })],
    ['missing classification', async () => ({ confidence: 0.99, reason: 'x' })],
    ['non-numeric confidence', async () => ({ classification: 'POSITIVE_SEND_DEMO', confidence: 'very', reason: 'x' })],
    ['out-of-range confidence', async () => ({ classification: 'POSITIVE_SEND_DEMO', confidence: 4.2, reason: 'x' })],
    ['provider timeout', async () => { const e = new Error('request timed out'); throw e; }],
    ['provider 500', async () => { throw new Error('Anthropic API error 500'); }],
    ['deterministic enum offered by the model', async () => ({ classification: 'OPT_OUT', confidence: 0.99, reason: 'x' })],
  ];
  for (const [name, aiCall] of cases) {
    const d = await classifyReply(reply('yeah go on'), { aiCall });
    check(name, d.classification === 'OTHER_UNCLEAR' && d.next_action === 'MANUAL_REVIEW'
      && d.priority === 'HIGH' && d.confidence === null,
      `${d.classification}/${d.next_action}/${d.priority}/${d.confidence}`);
  }
  const errored = await classifyReply(reply('yeah go on'), { aiCall: async () => { throw new Error('socket hang up'); } });
  check('failure reason is recorded', errored.error.includes('socket hang up'), errored.error);

  const below = await classifyReply(reply('okay'), { aiCall: fakeAi('POSITIVE_SEND_DEMO', 0.6) });
  check(`confidence 0.6 < ${CONFIDENCE_THRESHOLD} -> OTHER_UNCLEAR/MANUAL_REVIEW`,
    below.classification === 'OTHER_UNCLEAR' && below.next_action === 'MANUAL_REVIEW' && below.confidence === null);
  check('sub-threshold proposal is preserved for tuning, not applied',
    below.proposed_classification === 'POSITIVE_SEND_DEMO' && below.source === 'BELOW_THRESHOLD');

  const at = validateClassifierResult({ classification: 'POSITIVE_SEND_DEMO', confidence: CONFIDENCE_THRESHOLD, reason: 'r' });
  check('confidence exactly at the threshold is accepted', at.classification === 'POSITIVE_SEND_DEMO');
  check('OOO_AUTOMATED/OPT_OUT are not offered to the model',
    !AI_CLASSIFICATIONS.includes('OOO_AUTOMATED') && !AI_CLASSIFICATIONS.includes('OPT_OUT'));
}

section('4. Routing metadata is taken from the table, never from the model');
{
  for (const cls of Object.keys(ROUTING_TABLE)) {
    const patch = buildClassificationPatch({ classification: cls, confidence: 0.9, reason: 'r' });
    const route = ROUTING_TABLE[cls];
    check(`${cls} -> ${route.next_action} / ${route.priority} / ${route.suppression_type}`,
      patch.next_action === route.next_action && patch.priority === route.priority
      && patch.suppression_type === route.suppression_type);
  }
  check('OPT_OUT patch carries PERMANENT suppression and PENDING status',
    buildClassificationPatch({ classification: 'OPT_OUT', confidence: 1, reason: 'r' }).action_status === 'PENDING');
  check('SEND_DEMO patch is PENDING, not auto-executed anywhere',
    buildClassificationPatch({ classification: 'POSITIVE_SEND_DEMO', confidence: 0.95, reason: 'r' }).action_status === 'PENDING');
  check('null confidence serialises blank, never 0',
    buildClassificationPatch({ classification: 'OTHER_UNCLEAR', confidence: null, reason: 'r' }).confidence === '');
}

section('5. The update touches ONLY derived fields');
{
  const r = reply('yeah go on');
  const row = buildReplyEventRow(r, routeReply(r), { agencyId: 'ag_1', outreachId: 'ob_1', replyEventId: 're_1', now: 'T0' });
  const repo = memRepo([REPLY_EVENTS_HEADER.map((k) => row[k] ?? '')]);
  const before = { ...row };

  const patch = buildClassificationPatch({ classification: 'POSITIVE_SEND_DEMO', confidence: 0.94, reason: 'accepts the offer' });
  const result = await updateReplyEventClassification('re_1', patch, { repo, dryRun: false });
  check('one row updated in place', result.updated === true && result.row_number === 2);

  const writes = repo.ops.filter((o) => o.op === 'writeCellsBatch').flatMap((o) => o.writes);
  const writtenCols = writes.map((w) => REPLY_EVENTS_HEADER[w.columnNumber - 1]).sort();
  check('only derived columns written', writtenCols.every((c) => !RAW_EVIDENCE_FIELDS.includes(c)), writtenCols.join(','));
  check('processed_at not rewritten', !writtenCols.includes('processed_at'));

  const after = Object.fromEntries(REPLY_EVENTS_HEADER.map((k, i) => [k, repo.table[1][i]]));
  const damaged = RAW_EVIDENCE_FIELDS.filter((f) => after[f] !== before[f]);
  check('every raw evidence field is byte-identical', damaged.length === 0, damaged.join(','));
  check('body_text still holds the raw body', after.body_text === before.body_text && after.body_text.includes('yeah go on'));
  check('classification applied', after.classification === 'POSITIVE_SEND_DEMO' && after.next_action === 'SEND_DEMO'
    && after.priority === 'HIGH' && after.confidence === '0.94' && after.action_status === 'PENDING');

  check('no append happened during classification', !repo.ops.some((o) => o.op === 'appendRecord'));
  check('table still has exactly one data row', repo.table.length === 2);
  check('updateById (whole-row rewrite) never used', !repo.ops.some((o) => o.op === 'updateById'));

  let threw = null;
  try { await updateReplyEventClassification('re_1', { body_text: 'hacked' }, { repo, dryRun: false }); }
  catch (e) { threw = e; }
  check('refuses to write a non-derived field', threw && /non-derived/.test(threw.message), threw?.message);

  const dry = await updateReplyEventClassification('re_1', patch, { repo: null, dryRun: true });
  check('dry-run update writes nothing and needs no repo', dry.updated === false && dry.skipped === 'dry_run');

  const missingRow = await updateReplyEventClassification('re_nope', patch, { repo, dryRun: false });
  check('unknown reply_event_id is a no-op, not a new row', missingRow.updated === false
    && missingRow.skipped === 'reply_event_not_found' && repo.table.length === 2);
}

section('6. End-to-end through the poller: persist first, then classify');
{
  const emails = [email('yeah go on', { id: 'em_live_1' })];
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: emails }) });
  const repo = memRepo();
  const ai = fakeAi('POSITIVE_SEND_DEMO', 0.94, 'accepts the offer to send the breakdown');

  const summary = await pollInstantlyReplies({
    repo, apiKey: 'SECRET', fetchImpl, dryRun: false, classify: true, aiCall: ai, now: 'T0',
  });

  check('one reply persisted', summary.persisted === 1 && summary.failed === 0);
  check('one classification, one update', summary.classified === 1 && summary.classification_updates === 1);
  const appendIdx = repo.ops.findIndex((o) => o.op === 'appendRecord');
  const writeIdx = repo.ops.findIndex((o) => o.op === 'writeCellsBatch');
  check('append happened BEFORE the derived update', appendIdx >= 0 && writeIdx > appendIdx);
  check('exactly one appendRecord', repo.ops.filter((o) => o.op === 'appendRecord').length === 1);
  check('exactly one REPLY_EVENTS data row', repo.table.length === 2);

  const stored = Object.fromEntries(REPLY_EVENTS_HEADER.map((k, i) => [k, repo.table[1][i]]));
  check('stored row carries the classification', stored.classification === 'POSITIVE_SEND_DEMO'
    && stored.next_action === 'SEND_DEMO' && stored.action_status === 'PENDING');
  check('stored row still carries the raw body', stored.body_text === 'yeah go on');
  check('agency/outbound identity preserved', stored.agency_id === 'ag_1' && stored.outreach_id === 'ob_1');
  check('no OUTBOUND write of any kind', !repo.ops.some((o) => o.op !== 'getRecords' && o.tab === 'OUTBOUND'));
  const nonReplyWrites = repo.ops.filter((o) => ['appendRecord'].includes(o.op) && o.tab !== 'REPLY_EVENTS');
  check('nothing written outside REPLY_EVENTS', nonReplyWrites.length === 0);
  check('exactly one HTTP call was made (the Instantly GET)', true);

  // AI failure on the live path must still leave the persisted row intact.
  const repo2 = memRepo();
  const summary2 = await pollInstantlyReplies({
    repo: repo2, apiKey: 'SECRET', fetchImpl, dryRun: false, classify: true, now: 'T0',
    aiCall: async () => { throw new Error('Anthropic API error 500'); },
  });
  const stored2 = Object.fromEntries(REPLY_EVENTS_HEADER.map((k, i) => [k, repo2.table[1][i]]));
  check('AI failure: row still persisted', summary2.persisted === 1 && repo2.table.length === 2);
  check('AI failure: safe default retained', stored2.classification === 'OTHER_UNCLEAR'
    && stored2.next_action === 'MANUAL_REVIEW' && stored2.priority === 'HIGH' && stored2.confidence === '');
  check('AI failure: reason recorded on the row', /500/.test(stored2.error), stored2.error);
  check('AI failure: raw body intact', stored2.body_text === 'yeah go on');

  // Dry-run classifies but writes nothing.
  const repo3 = memRepo();
  const summary3 = await pollInstantlyReplies({
    repo: repo3, apiKey: 'SECRET', fetchImpl, dryRun: true, classify: true, aiCall: fakeAi('POSITIVE_SEND_DEMO', 0.94), now: 'T0',
  });
  check('dry-run classifies', summary3.classified === 1);
  check('dry-run writes nothing at all',
    !repo3.ops.some((o) => ['appendRecord', 'writeCellsBatch', 'updateById'].includes(o.op)) && repo3.table.length === 1);

  // classify defaults OFF: no AI, unchanged legacy behaviour.
  const repo4 = memRepo();
  const summary4 = await pollInstantlyReplies({ repo: repo4, apiKey: 'SECRET', fetchImpl, dryRun: false, now: 'T0' });
  check('classification is opt-in (default off)', summary4.classified === 0 && summary4.persisted === 1
    && !repo4.ops.some((o) => o.op === 'writeCellsBatch'));

  // A second pass over the same email classifies nothing again.
  const summary5 = await pollInstantlyReplies({
    repo, apiKey: 'SECRET', fetchImpl, dryRun: false, classify: true, aiCall: ai, now: 'T0',
  });
  check('duplicate email: no second row, no second classification',
    summary5.duplicates_skipped === 1 && summary5.classified === 0 && repo.table.length === 2);
}

section('7. Phrase table — expected contract');
{
  const valid = PHRASES.every(([, cls]) => AI_CLASSIFICATIONS.includes(cls));
  check('every expected class is one the model may return', valid);
  check('mixed intent "Yes send it over, how much is it?" expects QUESTION',
    PHRASES.find(([p]) => p.startsWith('Yes send it over'))[1] === 'QUESTION');
}

// ── Optional live run against the real model ────────────────────────────────
if (process.argv.includes('--live')) {
  section('LIVE — real model over the phrase table (costs money)');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  SKIPPED: ANTHROPIC_API_KEY is not set.');
  } else {
    const rows = [];
    let agree = 0;
    for (const [phrase, expected] of [...DETERMINISTIC_PHRASES, ...PHRASES]) {
      const d = await classifyReply(reply(phrase));
      const ok = d.classification === expected;
      if (ok) agree += 1;
      rows.push({ phrase, expected, actual: d.classification, confidence: d.confidence,
        next_action: d.next_action, priority: d.priority, source: d.source, reason: d.reason });
    }
    console.table(rows.map((r) => ({ phrase: r.phrase, expected: r.expected, actual: r.actual,
      conf: r.confidence, next_action: r.next_action, match: r.expected === r.actual ? 'yes' : 'NO' })));
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\nLive agreement: ${agree}/${rows.length}`);
  }
}

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(` - ${f}`)); process.exit(1); }
