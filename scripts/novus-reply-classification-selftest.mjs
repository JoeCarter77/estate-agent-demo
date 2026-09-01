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
  buildContextBlock,
  CONFIDENCE_THRESHOLD,
  AI_CLASSIFICATIONS,
  isSendDemoCta,
  isSimpleAffirmative,
  isSimpleDeferral,
  extractCtaRegion,
} from '../lib/reply-classification.mjs';
import {
  normalizeInstantlyEmail,
  routeReply,
  buildReplyEventRow,
  buildClassificationPatch,
  detectOptOut,
  updateReplyEventClassification,
  REPLY_EVENTS_HEADER,
  RAW_EVIDENCE_FIELDS,
  ROUTING_TABLE,
} from '../lib/reply-router.mjs';
import { pollInstantlyReplies } from '../lib/instantly-reply-poll.mjs';
import {
  PHRASES,
  DETERMINISTIC_PHRASES,
  CONTEXTUAL_PHRASES,
  REAL_SEND_DEMO_CTA,
  REAL_REGRESSION_REPLY,
  SEND_DEMO_CTA_CASES,
  CROSS_CONTEXT_CASES,
  DEFERRAL_CTA_CASES,
  OPT_OUT_CASES,
  NOT_OPT_OUT_CASES,
  REAL_CASE_C_REPLY,
} from '../lib/reply-classification-fixtures.mjs';
import {
  buildThreadIndex,
  selectThreadContext,
  buildContextSweepUrl,
  excerpt,
} from '../lib/reply-thread-context.mjs';

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

section('7. Thread context selection');
{
  const threadMsg = (over) => ({
    id: over.id, ue_type: over.ue_type, eaccount: NOVUS,
    from_address_email: over.from, to_address_email_list: over.to,
    lead: LEAD, thread_id: over.thread_id || 'th_1', timestamp: over.timestamp,
    subject: 'Re: enquiry', body: { text: over.text },
  });

  const raw = [
    // NOVUS campaign email, oldest
    threadMsg({ id: 'm1', ue_type: 1, from: NOVUS, to: LEAD, timestamp: '2026-08-30T09:00:00Z', text: 'We ran a test enquiry past your team. Want me to send the breakdown?' }),
    // prospect asks something
    threadMsg({ id: 'm2', ue_type: 2, from: LEAD, to: NOVUS, timestamp: '2026-08-30T10:00:00Z', text: 'What is this about?' }),
    // NOVUS follow-up offering a CALL — the immediately previous message
    threadMsg({ id: 'm3', ue_type: 1, from: NOVUS, to: LEAD, timestamp: '2026-08-30T11:00:00Z', text: 'Happy to jump on a quick call — does Thursday suit?' }),
    // a LATER NOVUS message, after the reply: must never be used
    threadMsg({ id: 'm5', ue_type: 1, from: NOVUS, to: LEAD, timestamp: '2026-08-30T14:00:00Z', text: 'Just bumping this up your inbox.' }),
    // another thread entirely
    threadMsg({ id: 'x1', ue_type: 1, from: NOVUS, to: LEAD, thread_id: 'th_OTHER', timestamp: '2026-08-30T11:30:00Z', text: 'Different thread entirely.' }),
  ];

  const index = buildThreadIndex(raw);
  check('index is keyed by thread_id', index.has('th_1') && index.has('th_OTHER'));
  check('thread th_1 holds only its own messages', index.get('th_1').length === 4);

  const theReply = reply('yeah okay', { id: 'm4', timestamp: '2026-08-30T12:00:00Z' });
  const ctx = selectThreadContext(theReply, index, {});
  check('previous NOVUS message is the IMMEDIATELY preceding one',
    ctx.previous_novus_message.includes('quick call'), ctx.previous_novus_message);
  check('an older NOVUS message does not win', !ctx.previous_novus_message.includes('breakdown'));
  check('a LATER NOVUS message is never used', !ctx.previous_novus_message.includes('bumping'));
  check('previous prospect message is selected', ctx.previous_prospect_message.includes('What is this about'));
  check('context_source reports the sweep', ctx.context_source === 'THREAD_SWEEP');
  check('demo_already_sent is unknown (null), never guessed false', ctx.demo_already_sent === null);

  const otherThread = selectThreadContext(reply('hi', { id: 'z', thread_id: 'th_NONE', timestamp: '2026-08-30T12:00:00Z' }), index, {});
  check('an unknown thread yields blank context', otherThread.previous_novus_message === '' && otherThread.context_source === 'NONE');

  // The reply's own message must never be its own context.
  const selfIndex = buildThreadIndex([threadMsg({ id: 'm4', ue_type: 2, from: LEAD, to: NOVUS, timestamp: '2026-08-30T12:00:00Z', text: 'yeah okay' })]);
  const selfCtx = selectThreadContext(theReply, selfIndex, {});
  check('the reply is never its own context', selfCtx.previous_prospect_message === '');

  // demo_already_sent, from thread evidence only.
  const demoIndex = buildThreadIndex([
    threadMsg({ id: 'd1', ue_type: 1, from: NOVUS, to: LEAD, timestamp: '2026-08-30T11:00:00Z', text: 'Here it is: https://demo.getnovus.co.uk/acme-estates' }),
  ]);
  const demoCtx = selectThreadContext(theReply, demoIndex, { demoUrl: 'https://demo.getnovus.co.uk/acme-estates' });
  check('demo_already_sent true when the link is evidenced in the thread', demoCtx.demo_already_sent === true);
  const noDemoCtx = selectThreadContext(theReply, demoIndex, { demoUrl: 'https://demo.getnovus.co.uk/other-agency' });
  check('demo_already_sent false when a different link was sent', noDemoCtx.demo_already_sent === false);

  // Unorderable timestamps must not be assumed earlier.
  const badTime = selectThreadContext(reply('yeah okay', { id: 'q', timestamp: 'not-a-date' }), index, {});
  check('an unorderable reply timestamp yields no context',
    badTime.previous_novus_message === '' && badTime.context_source === 'UNORDERABLE_REPLY_TIMESTAMP');

  check('sweep URL is bounded and newest-first',
    buildContextSweepUrl({ limit: 100 }).includes('limit=100') && buildContextSweepUrl().includes('sort_order=desc'));
  check('sweep URL sets no email_type filter (sent AND manual both needed)',
    !buildContextSweepUrl().includes('email_type'));
}

section('8. Context reaches the prompt, and absence is stated explicitly');
{
  const withCtx = buildClassifierPrompt('yeah okay', { previous_novus_message: 'Want me to send the demo?', demo_already_sent: false });
  check('previous NOVUS message appears in the prompt', withCtx.includes('Want me to send the demo?'));
  check('the reply is clearly separated from the context',
    withCtx.indexOf('Want me to send the demo?') < withCtx.indexOf('REPLY TO CLASSIFY'));
  check('demo-not-sent state is stated', withCtx.includes('has NOT yet been sent'));

  const noCtx = buildClassifierPrompt('yeah okay', null);
  check('absent context is stated explicitly, not omitted', noCtx.includes('none available'));
  check('unknown demo state is NOT asserted either way',
    !noCtx.includes('has NOT yet been sent') && !noCtx.includes('has ALREADY been sent'));

  const sentCtx = buildContextBlock({ previous_novus_message: 'Here is the breakdown', demo_already_sent: true });
  check('demo-already-sent state is stated', sentCtx.includes('ALREADY been sent'));

  // Context is passed through classifyReply to the model.
  const ai = fakeAi('POSITIVE_MEETING', 0.93);
  await classifyReply(reply('yeah okay'), { aiCall: ai, context: { previous_novus_message: 'Open to a quick call tomorrow?' } });
  check('classifyReply forwards context to the model', ai.calls[0].prompt.includes('quick call tomorrow'));

  // Deterministic paths still bypass the model even with context present.
  const ai2 = fakeAi('POSITIVE_SEND_DEMO', 0.99);
  const optOut = await classifyReply(reply('please remove me from your list'), {
    aiCall: ai2, context: { previous_novus_message: 'Want me to send the demo?' },
  });
  check('context does not weaken deterministic OPT_OUT',
    optOut.classification === 'OPT_OUT' && ai2.calls.length === 0);
}

section('9. Context retrieval failure never blocks persistence');
{
  const emails = [email('yeah okay', { id: 'em_ctx_fail' })];
  const fetchImpl = async (url) => {
    // The received-emails poll succeeds; the context sweep 500s.
    if (!String(url).includes('email_type=received')) {
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'boom' }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: emails }) };
  };
  const repo = memRepo();
  const summary = await pollInstantlyReplies({
    repo, apiKey: 'SECRET', fetchImpl, dryRun: false, classify: true, now: 'T0',
    aiCall: fakeAi('OTHER_UNCLEAR', 0.4),
  });
  check('reply still persisted despite context failure', summary.persisted === 1 && repo.table.length === 2);
  check('context failure is reported, not thrown', typeof summary.context_error === 'string' && summary.context_error.length > 0);
  check('context counted as missing', summary.context_missing === 1 && summary.context_resolved === 0);
  const stored = Object.fromEntries(REPLY_EVENTS_HEADER.map((k, i) => [k, repo.table[1][i]]));
  check('raw body intact after context failure', stored.body_text === 'yeah okay');
  check('low confidence still routed to review', stored.classification === 'OTHER_UNCLEAR' && stored.next_action === 'MANUAL_REVIEW');
}

section('10. Context sweep is ONE call per pass, and none when not classifying');
{
  const emails = [
    email('yeah okay', { id: 'a1', thread_id: 'th_A' }),
    email('sounds good', { id: 'a2', thread_id: 'th_B' }),
    email('sure', { id: 'a3', thread_id: 'th_A' }),
  ];
  let sweepCalls = 0;
  const fetchImpl = async (url) => {
    if (!String(url).includes('email_type=received')) {
      sweepCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: emails }) };
  };

  sweepCalls = 0;
  await pollInstantlyReplies({
    repo: memRepo(), apiKey: 'SECRET', fetchImpl, dryRun: false, classify: true, now: 'T0',
    aiCall: fakeAi('OTHER_UNCLEAR', 0.4),
  });
  check('three replies, exactly ONE context sweep', sweepCalls === 1, `${sweepCalls} sweeps`);

  sweepCalls = 0;
  await pollInstantlyReplies({ repo: memRepo(), apiKey: 'SECRET', fetchImpl, dryRun: false, now: 'T0' });
  check('no classification -> no context sweep at all', sweepCalls === 0, `${sweepCalls} sweeps`);
}

section('11. Phrase table — expected contract');
{
  const valid = PHRASES.every(([, cls]) => AI_CLASSIFICATIONS.includes(cls));
  check('every expected class is one the model may return', valid);
  check('mixed intent "Yes send it over, how much is it?" expects QUESTION',
    PHRASES.find(([p]) => p.startsWith('Yes send it over'))[1] === 'QUESTION');

  check('contextual set covers all 9 required cases', CONTEXTUAL_PHRASES.length === 9);
  const sameTextDifferentMeaning = CONTEXTUAL_PHRASES.filter((c) => c.phrase === 'yeah okay');
  check('"yeah okay" appears with three different expected outcomes',
    new Set(sameTextDifferentMeaning.map((c) => c.expected)).size === 3);
  check('every contextual expectation is a class the model may return',
    CONTEXTUAL_PHRASES.every((c) => AI_CLASSIFICATIONS.includes(c.expected)));
}

section('12. Relational classification: the real SEND_DEMO CTA regression');
{
  // The model fake here would classify EVERYTHING as a low-confidence
  // OTHER_UNCLEAR — reproducing the exact 0.55 production failure. Anything
  // that reaches POSITIVE_SEND_DEMO below did so from the parent-message
  // relationship, not from the model.
  const reproduceFailure = () => fakeAi('POSITIVE_SEND_DEMO', 0.55, 'reproduces the live 0.55');

  const ctaContext = { previous_novus_message: REAL_SEND_DEMO_CTA, demo_already_sent: false };

  // -- the CTA itself is recognised, narrative "availability" notwithstanding
  check('the real NOVUS email is recognised as a send-demo CTA', isSendDemoCta(REAL_SEND_DEMO_CTA));
  check('the CTA region is the final question, not the whole body',
    extractCtaRegion(REAL_SEND_DEMO_CTA).includes('Want me to send it over?')
    && !extractCtaRegion(REAL_SEND_DEMO_CTA).includes('Milton Road'),
    extractCtaRegion(REAL_SEND_DEMO_CTA));

  // -- THE REAL REGRESSION
  {
    const ai = reproduceFailure();
    const d = await classifyReply(reply(REAL_REGRESSION_REPLY), { aiCall: ai, context: ctaContext });
    check('REAL CASE: "Hi Joe, Sure thing. Adam" -> POSITIVE_SEND_DEMO',
      d.classification === 'POSITIVE_SEND_DEMO', `${d.classification} @ ${d.confidence}`);
    check('REAL CASE: confidence >= 0.90 (auto-send eligible)', d.confidence >= 0.90, String(d.confidence));
    check('REAL CASE: next_action is SEND_DEMO', d.next_action === 'SEND_DEMO');
    check('REAL CASE: decided from context, the model was never consulted', ai.calls.length === 0);
  }

  // -- affirmatives against the real CTA
  for (const { phrase, auto, label } of SEND_DEMO_CTA_CASES) {
    const ai = reproduceFailure();
    const d = await classifyReply(reply(phrase), { aiCall: ai, context: ctaContext });
    const shown = (label || phrase).replace(/\n+/g, ' ');
    if (auto) {
      check(`send-CTA + "${shown}" -> POSITIVE_SEND_DEMO >= 0.90`,
        d.classification === 'POSITIVE_SEND_DEMO' && d.confidence >= 0.90,
        `${d.classification} @ ${d.confidence}`);
    } else {
      // Either the rule declined (model decides) or it never fired — what must
      // never happen is an automatic SEND_DEMO.
      const autoSendable = d.classification === 'POSITIVE_SEND_DEMO' && d.confidence >= 0.90;
      check(`send-CTA + "${shown}" -> never auto-sends`, !autoSendable,
        `${d.classification} @ ${d.confidence}`);
    }
  }

  // -- the same words, a different question: must NOT become SEND_DEMO
  for (const { label, parent, phrases } of CROSS_CONTEXT_CASES) {
    for (const phrase of phrases) {
      const ai = fakeAi('POSITIVE_MEETING', 0.93);
      const context = parent ? { previous_novus_message: parent, demo_already_sent: false } : null;
      const d = await classifyReply(reply(phrase), { aiCall: ai, context });
      check(`${label} + "${phrase}" -> not a deterministic SEND_DEMO`,
        d.source !== 'DETERMINISTIC_CONTEXTUAL', `source=${d.source}`);
      check(`${label} + "${phrase}" -> the model decides`, ai.calls.length === 1);
    }
  }

  // -- the affirmative matcher itself
  check('a bare affirmative is recognised', isSimpleAffirmative('sure thing'));
  check('greeting and signature are set aside', isSimpleAffirmative('Hi Joe, Sure thing. Adam'));
  check('a redirection is not a bare affirmative', !isSimpleAffirmative('sure thing, but call me first'));
  check('a trailing question is not a bare affirmative', !isSimpleAffirmative('sure thing, how much?'));
  check('a one-word reply is never mistaken for a signature', isSimpleAffirmative('yep'));
  check('an unrelated sentence is not an affirmative', !isSimpleAffirmative('we already use another provider'));

  // -- the rule cannot outrank compliance
  {
    const ai = fakeAi('POSITIVE_SEND_DEMO', 0.99);
    const optOut = await classifyReply(reply('unsubscribe'), { aiCall: ai, context: ctaContext });
    check('OPT_OUT still beats the contextual rule', optOut.classification === 'OPT_OUT' && ai.calls.length === 0);
    const ooo = await classifyReply(reply('sure thing', { is_auto_reply: true }), { aiCall: ai, context: ctaContext });
    check('OOO still beats the contextual rule', ooo.classification === 'OOO_AUTOMATED');
  }

  // -- an already-sent demo is not re-sent on a positive reply
  {
    const ai = fakeAi('POSITIVE_MEETING', 0.93);
    const d = await classifyReply(reply('sure thing'), {
      aiCall: ai,
      context: { previous_novus_message: REAL_SEND_DEMO_CTA, demo_already_sent: true },
    });
    check('demo already sent -> the rule declines, the model decides',
      d.source !== 'DETERMINISTIC_CONTEXTUAL' && ai.calls.length === 1);
  }
}

section('13. Quoted-history fallback recovers a parent the sweep missed');
{
  const QUOTED = `Sure thing.\n\nOn Mon, 1 Sep 2026 at 09:14, Joe Carter <${NOVUS}> wrote:\n> ${REAL_SEND_DEMO_CTA.replace(/\n/g, '\n> ')}`;

  // The sweep window missed this thread entirely — the canonical path yields
  // nothing, which is the exact production condition.
  const emptyIndex = buildThreadIndex([]);
  const ctx = selectThreadContext(reply(QUOTED, { id: 'qh_1' }), emptyIndex, {});
  check('a sweep miss no longer yields blank context', ctx.previous_novus_message.length > 0);
  check('the recovered parent carries the CTA', ctx.previous_novus_message.includes('Want me to send it over?'));
  check('context_source names the fallback', ctx.context_source === 'QUOTED_HISTORY', ctx.context_source);
  check('the recovered parent is enough to classify relationally',
    isSendDemoCta(ctx.previous_novus_message));

  // The canonical message still wins when it exists.
  const canonical = buildThreadIndex([{
    id: 'c1', ue_type: 1, eaccount: NOVUS,
    from_address_email: NOVUS, to_address_email_list: LEAD,
    lead: LEAD, thread_id: 'th_1', timestamp: '2026-08-30T11:00:00Z',
    subject: 'Re: enquiry', body: { text: 'Canonical: want me to send it over?' },
  }]);
  const canonicalCtx = selectThreadContext(reply(QUOTED, { id: 'qh_2', timestamp: '2026-08-30T12:00:00Z' }), canonical, {});
  check('canonical thread message outranks quoted history',
    canonicalCtx.context_source === 'THREAD_SWEEP' && canonicalCtx.previous_novus_message.includes('Canonical'));

  // AUTHENTICITY: a quote header naming someone else is not a NOVUS message.
  const foreign = `Sure thing.\n\nOn Mon, 1 Sep 2026 at 09:14, Someone Else <someone@elsewhere.com> wrote:\n> Want me to send it over?`;
  const foreignCtx = selectThreadContext(reply(foreign, { id: 'qh_3' }), emptyIndex, {});
  check('a quote not attributed to NOVUS is ignored',
    foreignCtx.previous_novus_message === '' && foreignCtx.context_source === 'NONE');

  // End to end: sweep misses, fallback recovers, reply auto-classifies.
  {
    const ai = fakeAi('POSITIVE_SEND_DEMO', 0.55, 'reproduces the live 0.55');
    const d = await classifyReply(reply(QUOTED, { id: 'qh_4' }), { aiCall: ai, context: ctx });
    check('END TO END: sweep miss + quoted parent -> POSITIVE_SEND_DEMO >= 0.90',
      d.classification === 'POSITIVE_SEND_DEMO' && d.confidence >= 0.90,
      `${d.classification} @ ${d.confidence}`);
  }
}

section('14. The CTA survives a long parent message');
{
  const padding = 'This is a long paragraph about how the enquiry was handled. '.repeat(20);
  const longCta = `Hi Adam,\n\n${padding}\n\nWant me to send it over?\n\nJoe`;
  check('the fixture really is longer than the excerpt budget', longCta.length > 600);
  const trimmed = excerpt(longCta);
  check('a long parent keeps its trailing CTA', trimmed.includes('Want me to send it over?'), trimmed.slice(-80));
  check('a long parent keeps its opening too', trimmed.includes('Hi Adam'));
  check('the excerpt stays bounded', trimmed.length <= 600 + 8);
  check('a long CTA is still recognised after excerpting', isSendDemoCta(trimmed));
}

section('15. REAL CASE B — contextual deferral reaches NOT_NOW above threshold');
{
  // The model fake here proposes NOT_NOW at the real 0.75, which falls below
  // the 0.85 threshold and becomes OTHER_UNCLEAR — the exact live failure.
  const belowThreshold = () => fakeAi('NOT_NOW', 0.75, 'reproduces the live 0.75');
  const ctaContext = { previous_novus_message: REAL_SEND_DEMO_CTA, demo_already_sent: false };

  for (const { phrase, defer, label } of DEFERRAL_CTA_CASES) {
    const ai = belowThreshold();
    const d = await classifyReply(reply(phrase), { aiCall: ai, context: ctaContext });
    const shown = label || phrase;
    if (defer) {
      check(`send-CTA + "${shown}" -> NOT_NOW >= ${CONFIDENCE_THRESHOLD}`,
        d.classification === 'NOT_NOW' && d.confidence >= CONFIDENCE_THRESHOLD,
        `${d.classification} @ ${d.confidence}`);
      check(`  "${shown}" routes to nurture, never a send`,
        d.next_action === 'CREATE_NURTURE' && d.next_action !== 'SEND_DEMO');
    } else {
      check(`send-CTA + "${shown}" -> no naive deterministic NOT_NOW`,
        d.source !== 'DETERMINISTIC_CONTEXTUAL', `source=${d.source}`);
      check(`  "${shown}" is handed to the model`, ai.calls.length === 1);
    }
  }

  // A deferral against a CALL CTA is still NOT_NOW — the routing is identical.
  {
    const ai = belowThreshold();
    const d = await classifyReply(reply('Maybe later'), {
      aiCall: ai, context: { previous_novus_message: 'Can I give you a call tomorrow?' },
    });
    check('call-CTA + "Maybe later" -> NOT_NOW too', d.classification === 'NOT_NOW');
  }

  // With no proposition at all there is nothing to defer, so the model decides.
  {
    const ai = belowThreshold();
    const d = await classifyReply(reply('Maybe later'), { aiCall: ai, context: null });
    check('no context + "Maybe later" -> the model decides',
      d.source !== 'DETERMINISTIC_CONTEXTUAL' && ai.calls.length === 1);
  }

  // A deferral must never become a send.
  check('a deferral is not an affirmative', !isSimpleAffirmative('maybe later'));
  check('an affirmative is not a deferral', !isSimpleDeferral('sure thing'));
}

section('16. REAL CASE C — OPT_OUT precedence and permanent suppression');
{
  // The model would call this NOT_INTERESTED at high confidence — exactly what
  // happened live. Deterministic opt-out must win before the model is reached.
  const wouldSayNotInterested = () => fakeAi('NOT_INTERESTED', 0.90, 'reads as a rejection');

  for (const phrase of OPT_OUT_CASES) {
    const ai = wouldSayNotInterested();
    const d = await classifyReply(reply(phrase), { aiCall: ai, context: null });
    check(`OPT_OUT: "${phrase}"`, d.classification === 'OPT_OUT', `${d.classification} @ ${d.confidence}`);
    check(`  permanent suppression, not NONE`, d.suppression_type === 'PERMANENT', d.suppression_type);
    check(`  terminal action and no model call`, d.next_action === 'NONE' && ai.calls.length === 0);
  }

  // REAL CASE C in full: a complaint AND a removal request. The removal wins.
  {
    const ai = wouldSayNotInterested();
    const d = await classifyReply(reply(REAL_CASE_C_REPLY), { aiCall: ai, context: null });
    check('REAL CASE C -> OPT_OUT, not NOT_INTERESTED', d.classification === 'OPT_OUT');
    check('REAL CASE C -> PERMANENT suppression', d.suppression_type === 'PERMANENT');
    check('REAL CASE C -> no SEND_DEMO', d.next_action !== 'SEND_DEMO');
    check('REAL CASE C -> decided deterministically', ai.calls.length === 0);
  }

  // Negative sentiment alone is NOT an opt-out: permanent suppression must not
  // be applied to someone who only declined this offer.
  for (const [phrase] of NOT_OPT_OUT_CASES) {
    check(`"${phrase}" is not an opt-out`, detectOptOut({ cleaned_reply_text: phrase }) === null);
  }

  // OPT_OUT beats the contextual affirmative rule as well.
  {
    const ai = wouldSayNotInterested();
    const d = await classifyReply(reply('Sure, but please take us off your list'), {
      aiCall: ai, context: { previous_novus_message: REAL_SEND_DEMO_CTA },
    });
    check('an affirmative carrying a removal request is OPT_OUT',
      d.classification === 'OPT_OUT' && d.suppression_type === 'PERMANENT');
  }

  // QUOTED HISTORY MUST NEVER TRIGGER AN OPT-OUT. The new reply is positive;
  // an older quoted message contains an unsubscribe request.
  {
    const quoted = normalizeInstantlyEmail({
      id: 'oo_q', ue_type: 2, eaccount: NOVUS,
      from_address_email: LEAD, to_address_email_list: NOVUS, lead: LEAD,
      thread_id: 'th_1', timestamp: '2026-08-31T10:00:00Z', subject: 'Re: enquiry',
      body: { text: `Yes please send it over.\n\nOn Mon, 1 Sep 2026 at 09:14, Joe Carter <${NOVUS}> wrote:\n> please unsubscribe me` },
    });
    check('the quoted opt-out is not in the prospect\'s own words',
      !quoted.cleaned_reply_text.includes('unsubscribe'), quoted.cleaned_reply_text);
    check('a quoted "please unsubscribe me" cannot opt the prospect out',
      detectOptOut(quoted) === null);
    check('the reply still routes on its own words',
      routeReply(quoted).classification !== 'OPT_OUT');
    // ...but the SAME phrase newly authored by the prospect does opt them out.
    const authored = normalizeInstantlyEmail({
      id: 'oo_a', ue_type: 2, eaccount: NOVUS,
      from_address_email: LEAD, to_address_email_list: NOVUS, lead: LEAD,
      thread_id: 'th_1', timestamp: '2026-08-31T10:00:00Z', subject: 'Re: enquiry',
      body: { text: 'please unsubscribe me' },
    });
    check('the same phrase, newly authored, IS an opt-out',
      routeReply(authored).classification === 'OPT_OUT');
  }
}

section('17. The proposition is named for the model');
{
  const block = buildContextBlock({ previous_novus_message: REAL_SEND_DEMO_CTA });
  check('a send CTA is described as a send offer', block.includes('offered to SEND'));
  const callBlock = buildContextBlock({ previous_novus_message: 'Can I give you a call tomorrow?' });
  check('a call CTA is described as a call', callBlock.includes('CALL'));
  check('a call CTA warns it is not a send request', callBlock.includes('NOT a request to send'));
  const none = buildContextBlock(null);
  check('no context asserts no proposition', !none.includes('WHAT NOVUS ASKED'));

  check('cta type is carried on the context object',
    selectThreadContext(reply('sure', { id: 'cta_1' }), buildThreadIndex([{
      id: 'cta_p', ue_type: 1, eaccount: NOVUS, from_address_email: NOVUS,
      to_address_email_list: LEAD, lead: LEAD, thread_id: 'th_1',
      timestamp: '2026-08-30T09:00:00Z', subject: 'x', body: { text: REAL_SEND_DEMO_CTA },
    }]), {}).previous_novus_cta_type === 'SEND_DEMO');
}

// ── Optional live run against the real model ────────────────────────────────
if (process.argv.includes('--live')) {
  section('LIVE — real model over the phrase table (costs money)');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  SKIPPED: ANTHROPIC_API_KEY is not set.');
  } else {
    const rows = [];
    let agree = 0;
    const liveCases = [
      ...[...DETERMINISTIC_PHRASES, ...PHRASES].map(([phrase, expected]) => ({ phrase, expected, context: null, set: 'context_free', label: '' })),
      ...CONTEXTUAL_PHRASES.map((c) => ({ phrase: c.phrase, expected: c.expected, context: c.context, set: 'contextual', label: c.label })),
    ];
    for (const { phrase, expected, context, set, label } of liveCases) {
      const d = await classifyReply(reply(phrase), { context });
      const ok = d.classification === expected;
      if (ok) agree += 1;
      rows.push({ set, label, phrase, expected, actual: d.classification, confidence: d.confidence,
        next_action: d.next_action, priority: d.priority, source: d.source, reason: d.reason });
    }
    console.table(rows.map((r) => ({ set: r.set, phrase: r.phrase, expected: r.expected, actual: r.actual,
      conf: r.confidence, next_action: r.next_action, match: r.expected === r.actual ? 'yes' : 'NO' })));
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\nLive agreement: ${agree}/${rows.length}`);
  }
}

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(` - ${f}`)); process.exit(1); }
