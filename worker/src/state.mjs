// worker/src/state.mjs — the operator's persistent workflow state.
//
// SCOPE. This file holds OPERATIONAL state only: where the browser is in the
// twelve-step workflow, and what has already irreversibly happened for the
// agency currently in hand. It is deliberately NOT a probe database. Probe
// identity, probe_status, probe_timestamp, observation_deadline and
// AGENCIES.probe_sent are owned by NOVUS and are never written here — the
// fields below only remember what the operator did in the browser so that a
// crash cannot cause the one thing that can never be undone: a second genuine
// enquiry to a real estate agent.
//
// THE DUPLICATE-SUBMISSION RULE, in full.
//   submission.state = 'none'        nothing was attempted; safe to submit.
//   submission.state = 'in_flight'   the Send button was clicked and no
//                                    definitive result was seen yet. On
//                                    recovery this is NEVER retried: it becomes
//                                    a human-review item, because the enquiry
//                                    may well have gone out.
//   submission.state = 'sent'        a definitive success was observed. Recovery
//                                    resumes at Create probe, never at the form.
//   submission.state = 'failed'      a definitive failure was observed (the form
//                                    rejected it and no enquiry left). Safe to
//                                    retry within the attempt budget.
//
// Writes are atomic (tmp file + rename) so a kill -9 mid-write cannot leave a
// truncated state file that would read as "nothing happened".

import fs from 'node:fs';
import path from 'node:path';

export const STAGES = [
  'idle',
  'loading_queue',
  'agency_loaded',
  'branch_open',
  'property_selected',
  'property_open',
  'url_captured',
  'form_open',
  'form_verified',
  'submitting',
  'submitted',
  'probe_created',
  'marked_sent',
  'skipping',
  'needs_human',
  'failed',
];

export const RUN_MODES = ['stopped', 'running', 'paused', 'stopping_after_agency', 'needs_human'];

function emptyTransaction() {
  return {
    agency_id: '',
    agency_name: '',
    agency_updated_at: '',
    branch_url: '',
    property_url: '',
    property_title: '',
    stage: 'idle',
    submission: { state: 'none', attempts: 0, started_at: '', settled_at: '', evidence: '', detail: '' },
    probe_id: '',
    probe_reference: '',
    marked_sent: false,
    needs_human: null,          // { reason, detail, since }
    last_error: '',
    last_progress_at: '',
    started_at: '',
  };
}

function emptyState() {
  return {
    version: 1,
    run: {
      mode: 'stopped',
      batch_size: 0,
      daily_limit: 0,
      started_at: '',
      stop_reason: '',
      live_submit: false,
    },
    current: emptyTransaction(),
    counters: {
      completed: 0,
      skipped: 0,
      failed: 0,
      interventions: 0,
      day: '',
      completed_today: 0,
    },
    ai: { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    last_success: '',           // human-readable, e.g. "Sterling Estate Agents — marked sent 14:22"
    history: [],                // most recent 50 completed/skipped/failed cycles
    updated_at: '',
  };
}

export class OperatorState {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyState();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...emptyState(), ...parsed };
        this.data.current = { ...emptyTransaction(), ...(parsed.current || {}) };
        this.data.current.submission = {
          ...emptyTransaction().submission,
          ...(parsed.current?.submission || {}),
        };
        this.data.counters = { ...emptyState().counters, ...(parsed.counters || {}) };
        this.data.run = { ...emptyState().run, ...(parsed.run || {}) };
        this.data.ai = { ...emptyState().ai, ...(parsed.ai || {}) };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt state file must not be silently replaced: an unreadable
        // file may still be hiding an in-flight submission.
        throw new Error(`Operator state at ${this.filePath} is unreadable (${error.message}). Inspect it before starting — it may record an unsettled enquiry.`);
      }
    }
    return this.data;
  }

  save() {
    this.data.updated_at = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
    return this.data;
  }

  // ── transaction ──────────────────────────────────────────────────────────

  beginAgency({ agency_id, agency_name, agency_updated_at, branch_url }) {
    this.data.current = {
      ...emptyTransaction(),
      agency_id: String(agency_id || ''),
      agency_name: String(agency_name || ''),
      agency_updated_at: String(agency_updated_at || ''),
      branch_url: String(branch_url || ''),
      stage: 'agency_loaded',
      started_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
    };
    return this.save();
  }

  stage(stage, patch = {}) {
    if (!STAGES.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
    Object.assign(this.data.current, patch, { stage, last_progress_at: new Date().toISOString() });
    return this.save();
  }

  // Called immediately BEFORE the Send button is clicked. The write lands on
  // disk first, so a crash during the click is still recorded as in_flight.
  markSubmitInFlight() {
    const s = this.data.current.submission;
    s.state = 'in_flight';
    s.attempts += 1;
    s.started_at = new Date().toISOString();
    s.settled_at = '';
    s.detail = '';
    return this.stage('submitting');
  }

  settleSubmission(state, { evidence = '', detail = '' } = {}) {
    if (!['sent', 'failed'].includes(state)) throw new Error(`Bad submission settlement: ${state}`);
    const s = this.data.current.submission;
    s.state = state;
    s.settled_at = new Date().toISOString();
    s.evidence = evidence;
    s.detail = detail;
    return this.stage(state === 'sent' ? 'submitted' : 'form_verified');
  }

  requireHuman(reason, detail = '') {
    this.data.current.needs_human = { reason, detail, since: new Date().toISOString() };
    this.data.counters.interventions += 1;
    this.data.run.mode = 'needs_human';
    return this.stage('needs_human');
  }

  clearHuman() {
    this.data.current.needs_human = null;
    return this.save();
  }

  fail(message) {
    this.data.current.last_error = String(message || '').slice(0, 500);
    return this.stage('failed');
  }

  // ── cycle completion ─────────────────────────────────────────────────────

  finishCycle(outcome) {
    const c = this.data.current;
    const entry = {
      outcome,                                   // completed | skipped | failed | abandoned
      agency_id: c.agency_id,
      agency_name: c.agency_name,
      property_url: c.property_url,
      probe_id: c.probe_id,
      probe_reference: c.probe_reference,
      submission: c.submission.state,
      error: c.last_error,
      at: new Date().toISOString(),
    };
    this.data.history.unshift(entry);
    this.data.history = this.data.history.slice(0, 50);
    if (outcome === 'completed') {
      this.data.counters.completed += 1;
      this.bumpToday();
      this.data.last_success = `${c.agency_name || c.agency_id} — ${c.probe_reference || 'probe'} marked as sent`;
    }
    if (outcome === 'skipped') this.data.counters.skipped += 1;
    if (outcome === 'failed') this.data.counters.failed += 1;
    this.data.current = emptyTransaction();
    return this.save();
  }

  bumpToday() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.data.counters.day !== today) {
      this.data.counters.day = today;
      this.data.counters.completed_today = 0;
    }
    this.data.counters.completed_today += 1;
  }

  completedToday() {
    const today = new Date().toISOString().slice(0, 10);
    return this.data.counters.day === today ? this.data.counters.completed_today : 0;
  }

  recordAi({ inputTokens = 0, outputTokens = 0, costUsd = 0 }) {
    this.data.ai.calls += 1;
    this.data.ai.input_tokens += inputTokens;
    this.data.ai.output_tokens += outputTokens;
    this.data.ai.cost_usd = Number((this.data.ai.cost_usd + costUsd).toFixed(6));
    return this.save();
  }

  setRun(patch) {
    Object.assign(this.data.run, patch);
    return this.save();
  }
}

// RECOVERY DECISION. Given a state file left behind by a crashed or killed
// worker, say what the next start is allowed to do. This is the single place
// that decides whether an enquiry may be re-attempted, and it is deliberately
// pessimistic: anything short of a recorded definitive outcome is human review.
export function recoveryPlan(current) {
  const stage = current?.stage || 'idle';
  const submission = current?.submission?.state || 'none';
  const hasAgency = Boolean(String(current?.agency_id || '').trim());

  if (!hasAgency || stage === 'idle') {
    return { action: 'fresh', reason: 'no agency was in hand' };
  }
  if (stage === 'needs_human') {
    return { action: 'human', reason: current.needs_human?.reason || 'human intervention was already required' };
  }
  if (submission === 'in_flight') {
    return {
      action: 'human',
      reason: 'uncertain_submission',
      detail: 'The worker stopped after clicking Send on the Rightmove enquiry and before a definitive result was seen. The enquiry may already have reached the agent. Check the probe mailbox, then release or abandon this agency — the operator will not resubmit.',
    };
  }
  if (submission === 'sent' && current.marked_sent) {
    return { action: 'close_cycle', reason: 'the probe was already marked as sent; closing the cycle and moving on' };
  }
  if (submission === 'sent' && current.probe_id) {
    return { action: 'resume_mark_sent', reason: 'the enquiry was sent and the probe exists; resuming at Mark as sent' };
  }
  if (submission === 'sent') {
    return { action: 'resume_create_probe', reason: 'the enquiry was sent but no probe was created; resuming at Create probe' };
  }
  // Nothing irreversible happened for this agency.
  return { action: 'restart_agency', reason: `nothing was submitted for this agency (stage ${stage}); restarting it from the queue` };
}
