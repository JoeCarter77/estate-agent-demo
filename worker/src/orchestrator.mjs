// worker/src/orchestrator.mjs — the twelve-step workflow, as a state machine.
//
// Reads top to bottom in the order of the manual process it replaces. Every
// backend effect is produced by clicking the existing NOVUS Prober; nothing in
// here writes to Sheets, invents a probe id, or reimplements "sent".
//
// THREE RULES THAT OVERRIDE EVERYTHING ELSE
//   1. An enquiry whose outcome is not definitively known is never retried.
//      It becomes a human-review item with the agency preserved.
//   2. State reaches disk BEFORE the irreversible action, never after.
//   3. A human intervention never discards the agency. Pausing keeps the tab,
//      the property and the submission state exactly as they are.

import {
  verifyBranchPage, readBranchCandidates, openProperty, openEnquiryForm,
  verifyAndPrepareEnquiry, submitEnquiry, observeSubmissionOutcome, propertyIdOf,
} from './rightmove.mjs';
import { chooseListing } from './suitability.mjs';
import { ProberPage } from './novus-prober.mjs';
import { detectChallenge } from './browser.mjs';
import { isProbeRecordedAsSent } from './novus-client.mjs';
import { describeIntervention, notifyIntervention } from './notify.mjs';
import { assessListing, classifyUnknownPage } from './ai.mjs';
import { recoveryPlan } from './state.mjs';
import { cooldownMs } from './config.mjs';

class EmergencyStop extends Error {}
class HumanNeeded extends Error {
  constructor(reason, detail) { super(`${reason}: ${detail}`); this.reason = reason; this.detail = detail; }
}

// A skip records a reason on the kept AGENCIES row and takes it out of the
// queue (restorable). It is still only ever automatic for the cases below,
// each decided from an explicit, countable fact on the page — never from a
// model's opinion and never from an absence of data. Labels are the Prober's
// own skip reasons.
const AUTO_SKIP = {
  lettings_only: 'Unsuitable agency',
  no_sales_listings: 'No suitable Rightmove listing',
  bad_branch_page: 'No suitable Rightmove listing',
};

export class Orchestrator {
  constructor({ config, state, browser, novus, log = console.log, notify = notifyIntervention }) {
    this.config = config;
    this.state = state;
    this.browser = browser;
    this.novus = novus;
    this.log = log;
    this.notify = notify;
    this.prober = null;
    this.emergency = false;
    this.releaseResolver = null;
    this.loopPromise = null;
  }

  // ── run control (what the NOVUS panel drives) ────────────────────────────

  async start({ batchSize, dailyLimit, liveSubmit }) {
    if (this.loopPromise) return { ok: false, error: 'the operator is already running' };
    const plan = recoveryPlan(this.state.data.current);
    if (plan.action === 'human') {
      this.raiseHuman(plan.reason, plan.detail || plan.reason);
      return { ok: false, error: `human review is outstanding: ${plan.reason}` };
    }
    this.emergency = false;
    this.state.setRun({
      mode: 'running',
      batch_size: Number(batchSize) || this.config.defaultBatchSize,
      daily_limit: Number(dailyLimit) || this.config.dailyProbeLimit,
      started_at: new Date().toISOString(),
      stop_reason: '',
      live_submit: Boolean(liveSubmit) && this.config.liveSubmit,
    });
    this.loopPromise = this.loop(plan).catch((error) => {
      this.log('[operator] run ended with error:', error.message);
      this.state.setRun({ mode: 'stopped', stop_reason: error.message });
    }).finally(() => { this.loopPromise = null; });
    return { ok: true, recovery: plan };
  }

  pause() { if (this.state.data.run.mode === 'running') this.state.setRun({ mode: 'paused' }); return { ok: true }; }

  resume() {
    if (this.state.data.run.mode === 'paused') this.state.setRun({ mode: 'running' });
    return { ok: true };
  }

  stopAfterAgency() { this.state.setRun({ mode: 'stopping_after_agency' }); return { ok: true }; }

  // EMERGENCY STOP. Aborts at the next checkpoint and closes the browser. It
  // does NOT clear the transaction: if an enquiry was in flight when it was
  // pressed, that stays on the record and the next start goes to human review.
  async emergencyStop() {
    this.emergency = true;
    this.state.setRun({ mode: 'stopped', stop_reason: 'emergency stop' });
    if (this.releaseResolver) { this.releaseResolver('abort'); this.releaseResolver = null; }
    await this.browser.close().catch(() => {});
    return { ok: true };
  }

  // The human has finished the challenge and hands the session back (step 9.7).
  //
  // 'resume'          look at the page again — the operator re-reads it, never re-sends.
  // 'confirmed_sent'  the human saw Rightmove's confirmation with their own eyes.
  //                   Records the enquiry as sent and continues at Create probe.
  //                   It never presses Send; it only settles what already happened.
  // 'abandon'         leave this agency alone and move on.
  release({ outcome = 'resume' } = {}) {
    if (!this.state.data.current.needs_human) return { ok: false, error: 'nothing is waiting for you' };

    if (outcome === 'confirmed_sent') {
      const submission = this.state.data.current.submission;
      if (submission.state !== 'in_flight' && submission.state !== 'sent') {
        return { ok: false, error: 'there is no enquiry awaiting confirmation for this agency' };
      }
      if (submission.state === 'in_flight') {
        this.state.settleSubmission('sent', { detail: 'confirmed by the operator', confirmedBy: 'human' });
      }
      this.state.clearHuman();
      if (this.releaseResolver) {
        // A run is holding the page: it carries on from Create probe itself.
        this.state.setRun({ mode: 'running' });
        this.releaseResolver('confirmed_sent');
        this.releaseResolver = null;
      } else {
        // The worker was restarted since. Nothing is holding the page, so the
        // next Start recovers this agency at Create probe — no enquiry is
        // re-sent, because the submission is already settled as sent.
        this.state.setRun({ mode: 'stopped', stop_reason: 'enquiry confirmed by the operator — press Start to record it in NOVUS' });
      }
      return { ok: true, outcome: 'confirmed_sent' };
    }

    if (outcome === 'abandon') {
      this.state.clearHuman();
      this.state.fail('abandoned by operator after human review');
      this.state.finishCycle('abandoned');
      this.state.setRun({ mode: this.releaseResolver ? 'running' : 'stopped' });
      if (this.releaseResolver) { this.releaseResolver('abandon'); this.releaseResolver = null; }
      return { ok: true, outcome: 'abandon' };
    }
    if (!this.releaseResolver && this.state.data.current.submission.state === 'in_flight') {
      return { ok: false, error: 'this worker restarted after Send; confirm Rightmove’s success or abandon the agency. It cannot resubmit or infer the result.' };
    }
    this.state.clearHuman();
    if (this.releaseResolver) {
      this.state.setRun({ mode: 'running' });
      this.releaseResolver('resume'); this.releaseResolver = null;
    } else {
      const current = this.state.data.current;
      this.state.stage(current.submission.state === 'sent'
        ? (current.probe_id ? 'probe_created' : 'submitted') : 'failed');
      this.state.setRun({ mode: 'stopped', stop_reason: 'session released — press Start to continue safely' });
    }
    return { ok: true, outcome: 'resume' };
  }

  // ── checkpoints ──────────────────────────────────────────────────────────

  async checkpoint() {
    if (this.emergency) throw new EmergencyStop('emergency stop');
    while (this.state.data.run.mode === 'paused') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (this.emergency) throw new EmergencyStop('emergency stop');
    }
  }

  raiseHuman(reason, detail) {
    this.state.requireHuman(reason, detail);
    this.notify(describeIntervention(reason, detail, this.state.data.current), {
      onClick: () => this.browser.focusInterventionTab(this.state.data.current),
    });
  }

  // Blocks until the human releases the session. The browser stays open and
  // every tab stays exactly where it is — that is the whole point.
  async waitForRelease(reason, detail) {
    this.raiseHuman(reason, detail);
    const outcome = await new Promise((resolve) => { this.releaseResolver = resolve; });
    if (outcome === 'abort') throw new EmergencyStop('emergency stop during human review');
    return outcome;
  }

  // ── the run loop ─────────────────────────────────────────────────────────

  async loop(plan) {
    await this.browser.launch();
    const page = await this.browser.novusTab();
    this.prober = new ProberPage(page, this.config);

    let done = 0;
    const batch = this.state.data.run.batch_size;
    // The queue re-serves any agency whose probe_sent is still blank, which is
    // correct — but it means an agency the operator cannot finish would come
    // back forever. Count how many times the same agency is handed over
    // without progress and stop rather than spin.
    let lastAgencyId = '';
    let repeats = 0;

    // RECOVERY. Finish what the previous process left behind before touching
    // the queue, so a crash can never strand a sent enquiry without a probe.
    if (plan.action === 'resume_create_probe' || plan.action === 'resume_mark_sent' || plan.action === 'close_cycle') {
      this.log(`[operator] recovering: ${plan.reason}`);
      const recovered = await this.recover(plan);
      if (recovered) done += 1;
    } else if (plan.action === 'restart_agency') {
      this.log(`[operator] ${plan.reason}`);
      this.state.finishCycle('abandoned');
    }

    while (done < batch) {
      await this.checkpoint();
      if (this.state.data.run.mode === 'stopping_after_agency') break;

      if (this.state.completedToday() >= this.state.data.run.daily_limit) {
        this.state.setRun({ mode: 'stopped', stop_reason: 'daily probe limit reached' });
        break;
      }

      let outcome;
      try {
        outcome = await this.cycle();
      } catch (error) {
        if (error instanceof EmergencyStop) { this.log('[operator] emergency stop'); return; }
        if (error instanceof HumanNeeded) {
          const action = await this.waitForRelease(error.reason, error.detail);
          if (action === 'abandon') { outcome = 'abandoned'; }
          else if (this.state.data.current.submission.state === 'sent') outcome = await this.resumeSentWork();
          else if (this.state.data.current.submission.state === 'in_flight') {
            outcome = await this.resumeUncertainWork(error.detail);
          } else if (this.state.data.current.submission.state === 'failed') outcome = 'abandoned';
          else { continue; }                      // no Send: retry the same agency
        } else {
          this.log('[operator] cycle failed:', error.message);
          if (this.state.data.current.submission.state === 'in_flight') {
            outcome = await this.resumeUncertainWork(error.message);
          } else {
            const released = await this.waitForRelease('repeated_failure', error.message);
            if (released === 'abandon') outcome = 'abandoned';
            else if (this.state.data.current.submission.state === 'sent') outcome = await this.resumeSentWork();
            else continue;
          }
        }
      }

      if (outcome === 'queue_empty') {
        this.state.setRun({ mode: 'stopped', stop_reason: 'the probe queue is exhausted' });
        return;
      }
      if (outcome === 'completed') done += 1;
      // A dry run works a whole agency and deliberately stops before Send. It
      // counts against the batch so a dry run is bounded exactly like a live
      // one instead of re-serving the same agency forever.
      if (outcome === 'dry_run') done += 1;

      // PACING. Only after an enquiry actually went out, and only when there is
      // another one coming: nothing is gained by making the operator wait after
      // the last probe of a batch, after a skip, or after a dry run that sent
      // nothing at all.
      if (outcome === 'completed' && done < batch) await this.cooldown();

      const workedId = this.lastAgencyId || '';
      if (workedId && workedId === lastAgencyId && !['completed', 'skipped', 'dry_run'].includes(outcome)) {
        repeats += 1;
        if (repeats >= 2) {
          this.state.setRun({ mode: 'stopped', stop_reason: `stopped: ${workedId} could not be completed after ${repeats + 1} attempts` });
          return;
        }
      } else {
        repeats = 0;
      }
      lastAgencyId = workedId;
    }

    if (this.state.data.run.mode !== 'stopped') {
      this.state.setRun({
        mode: 'stopped',
        stop_reason: this.state.data.run.mode === 'stopping_after_agency'
          ? 'stopped after the current agency' : 'batch complete',
      });
    }
  }

  async resumeSentWork() {
    // Continue only with NOVUS recording. No path here returns to the form.
    while (true) {
      try {
        const current = this.state.data.current;
        if (current.marked_sent) {
          if (current.probe_id) {
            const probe = await this.novus.probe(current.probe_id).then((data) => data.probe).catch(() => null);
            if (!isProbeRecordedAsSent(probe)) {
              throw new HumanNeeded('probe_not_recorded', `PROBES ${current.probe_id} is still not observing; check NOVUS before releasing`);
            }
          }
          this.state.finishCycle('completed');
          return 'completed';
        }
        if (current.probe_id) return (await this.finishMarkSent()) === 'completed' ? 'completed' : 'abandoned';
        return this.createProbeAndMarkSent(current.property_url);
      } catch (error) {
        const released = await this.waitForRelease(error.reason || 'probe_not_recorded', error.detail || error.message);
        if (released === 'abandon') return 'abandoned';
      }
    }
  }

  async resumeUncertainWork(detail) {
    const page = this.browser.rightmoveTabs().at(-1);
    if (page) return this.resolveUncertainSubmission(page, 'editable', detail, this.state.data.current.property_url);
    const released = await this.waitForRelease('uncertain_submission', `${detail} — the submitted tab is no longer open`);
    if (released === 'abandon') return 'abandoned';
    if (this.state.data.current.submission.state === 'sent') return this.resumeSentWork();
    return this.resumeUncertainWork(detail);
  }

  // Resume a half-finished transaction without re-submitting anything.
  async recover(plan) {
    const current = this.state.data.current;
    await this.prober.openAgency(current.agency_id).catch(() => {});
    if (plan.action === 'close_cycle') { this.state.finishCycle('completed'); return true; }
    if (plan.action === 'resume_create_probe') {
      if (!String(current.property_url || '').trim()) {
        this.raiseHuman('probe_not_recorded',
          `${current.agency_name || current.agency_id}: the enquiry is recorded as sent but no property URL was captured, so the probe cannot be created automatically. Create it in the Prober by hand.`);
        return false;
      }
      const created = await this.createProbeAndMarkSent(current.property_url);
      return created === 'completed';
    }
    if (plan.action === 'resume_mark_sent') {
      // The probe exists. Reopen it by probe_id so Mark as sent acts on the
      // very row the previous process created, never a second one.
      const page = await this.browser.novusTab();
      await page.goto(`${this.config.novusBaseUrl}/novus/probe?probe_id=${encodeURIComponent(current.probe_id)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#view-ready', { timeout: this.config.timeouts.control });
      return (await this.finishMarkSent()) === 'completed';
    }
    return false;
  }

  // ── one agency, steps 1 → 12 ─────────────────────────────────────────────

  async cycle() {
    // STEP 1 — Start probing / next eligible agency.
    await this.pace();
    this.state.stage('loading_queue');
    const loaded = await this.prober.startProbing();
    if (loaded.empty) return 'queue_empty';
    if (loaded.error) throw new Error(loaded.error);

    // The dry-run guard: until live submission is authorised for a named test
    // agency, the operator refuses to work any other agency's enquiry.
    if (!this.state.data.run.live_submit && this.config.allowedAgencyIds.length
        && !this.config.allowedAgencyIds.includes(loaded.agencyId)) {
      throw new Error(`agency ${loaded.agencyId} is outside the authorised test set; live submission is not enabled`);
    }

    this.lastAgencyId = loaded.agencyId;
    const agencyRead = await this.novus.agency(loaded.agencyId).catch(() => ({}));
    const agency = agencyRead.agency || {};
    this.state.beginAgency({
      agency_id: loaded.agencyId,
      agency_name: loaded.agencyName || agency.agency_name || '',
      agency_updated_at: agency.updated_at || '',
      branch_url: loaded.branchUrl || agency.rightmove_sales_branch_url || '',
    });
    this.log(`[operator] agency: ${this.state.data.current.agency_name} (${loaded.agencyId})`);

    // BRAND / BRANCH GUARD — before any Rightmove tab is touched. If this
    // branch, its Rightmove page or another branch of the company was already
    // probed, probing again is a human decision (probe, skip or delete), and
    // NOVUS would refuse the probe after the enquiry had already gone out.
    const decision = agencyRead.relationship?.probe_decision || 'CLEAR';
    if (decision !== 'CLEAR') {
      throw new HumanNeeded('related_agency_probed', agencyRead.relationship_summary || decision);
    }
    await this.pace();

    // STEP 2 — the agency's Rightmove branch page, in its own tab.
    const branchPage = await this.acquireBranchTab();
    const verified = await verifyBranchPage(branchPage, {
      branchUrl: this.state.data.current.branch_url,
      agencyName: this.state.data.current.agency_name,
    });
    if (!verified.ok) {
      const challenge = await detectChallenge(branchPage);
      if (challenge) throw new HumanNeeded(challenge.kind, challenge.detail);
      // Deterministic detection found nothing it recognises, so the page is
      // genuinely unfamiliar. This is the one place a model is asked to name a
      // page, and it can only choose between escalating and carrying on — it
      // is never allowed to decide that an agency should be deleted.
      const triage = await this.triageUnknownPage(branchPage);
      throw new HumanNeeded(triage?.situation && triage.requires_human ? triage.situation : 'agency_page_unavailable',
        triage?.reason ? `${verified.reason} — ${triage.reason}` : verified.reason);
    }
    this.state.stage('branch_open');
    await this.pace();

    // STEP 3 — choose a suitable residential sales listing, or skip.
    const chosen = await this.selectProperty(branchPage, verified);
    if (chosen === 'skipped') return 'skipped';
    await this.pace();

    // STEP 4 & 5 — open it, verify ownership, capture the canonical URL.
    // Only the tab holding the listing that was chosen will do. Matching on the
    // property id means a stray tab — an interstitial, or the Prober's own
    // branch popup arriving late — can never be mistaken for it.
    const chosenId = propertyIdOf(chosen.href);
    const propertyPage = await this.browser.openBackgroundTab(chosen.href);
    if (!propertyPage) throw new HumanNeeded('agency_page_unavailable', 'the property tab would not open');
    this.state.stage('property_selected');

    const property = await openProperty(propertyPage, { agencyName: this.state.data.current.agency_name, branchId: verified.branchId });
    if (!property.ok) {
      if (property.challenge) throw new HumanNeeded(property.challenge.kind, property.challenge.detail);
      throw new HumanNeeded('uncertain_suitability', property.reason);
    }
    // The URL that goes into NOVUS comes from the property page itself, and it
    // must be the property that was chosen — never a neighbour, never a branch.
    if (chosenId && propertyIdOf(property.url) !== chosenId) {
      throw new HumanNeeded('uncertain_suitability',
        `the open tab is property ${propertyIdOf(property.url)} but ${chosenId} was chosen`);
    }
    this.state.stage('url_captured', { property_url: property.url, property_title: property.title });
    this.log(`[operator] property: ${property.url}`);
    await this.pace();

    // STEP 6 — the enquiry form.
    const form = await openEnquiryForm(propertyPage);
    if (!form.ok) {
      if (form.challenge) throw new HumanNeeded(form.challenge.kind, form.challenge.detail);
      throw new HumanNeeded('unexpected_form', form.reason);
    }
    // Rightmove renders the enquiry two ways: editable inputs when signed out,
    // and the account's details as read-only text with an Edit control when
    // signed in. Both are legitimate; which one is on screen decides how the
    // identity is checked and how "still on screen" is judged after Send.
    const layout = form.layout || 'editable';
    this.log(`[operator] enquiry form: ${layout === 'signed_in' ? 'signed-in summary' : 'editable fields'}`);
    this.state.stage('form_open');
    await this.pace();

    // STEP 7 — verify the approved identity and seller signal.
    const prepared = await verifyAndPrepareEnquiry(propertyPage, {
      identity: this.config.identity,
      propertyId: propertyIdOf(property.url),
      layout,
    });
    if (!prepared.ok) {
      // Keep the page itself, not just a sentence about it: if the layout has
      // moved again, this is what says how, without another live run to find out.
      const dump = await this.browser.saveFormEvidence(propertyPage, `form-${this.state.data.current.agency_id}`);
      throw new HumanNeeded('unexpected_form',
        [`${prepared.reason} (layout: ${prepared.layout || layout})`, ...(prepared.conflicts || []), dump ? `saved: ${dump}` : '']
          .filter(Boolean).join(' — '));
    }
    this.state.stage('form_verified');
    await this.pace();

    // STEP 8 — submit, and wait for a definitive result.
    if (!this.state.data.run.live_submit) {
      this.log('[operator] DRY RUN — the enquiry form is verified and filled; Send was not clicked.');
      await this.browser.saveEvidence(propertyPage, `dryrun-${this.state.data.current.agency_id}`);
      this.state.fail('dry run: live submission is not authorised, so this agency was not probed');
      await this.browser.closeRightmoveTabs();
      this.state.finishCycle('abandoned');
      return 'dry_run';
    }

    this.state.markSubmitInFlight();              // on disk BEFORE the click
    const result = await submitEnquiry(propertyPage, { timeout: this.config.timeouts.submitResult, layout });

    if (result.outcome === 'challenge') {
      // STEP 9 — never circumvent, never retry to avoid it, never drop the
      // agency. Send has already been pressed, so after the human clears the
      // challenge the page is RE-READ, never re-submitted: the recheck below
      // has no click in it at all, which is why clicking and observing are two
      // separate functions in rightmove.mjs.
      const released = await this.waitForRelease(result.challenge.kind, result.challenge.detail);
      if (released === 'abandon') return 'abandoned';
      if (released === 'confirmed_sent') {
        result.outcome = 'sent';
        result.detail = 'confirmed by the operator after completing the challenge';
      } else {
        // Rightmove reaches its confirmation by a full navigation once the
        // challenge is solved, so give the page a moment to land.
        const after = await observeSubmissionOutcome(propertyPage, { timeout: this.config.timeouts.submitResult, layout })
          .catch(() => ({ outcome: 'uncertain', detail: 'could not re-read the page after the challenge' }));
        if (after.outcome !== 'sent') {
          return this.resolveUncertainSubmission(propertyPage, layout,
            after.detail || 'the outcome after the challenge is unknown', property.url);
        }
        result.outcome = 'sent';
        result.detail = after.detail;
      }
    }

    if (result.outcome === 'uncertain') {
      return this.resolveUncertainSubmission(propertyPage, layout, result.detail, property.url);
    }
    if (result.outcome === 'failed') {
      // A definitive rejection means the enquiry demonstrably did not leave, so
      // nothing is at risk — but it also means the approved configuration no
      // longer satisfies the form. Retrying the agency would just send the same
      // rejected enquiry again, so this escalates on the first occurrence.
      this.state.settleSubmission('failed', { detail: result.detail });
      throw new HumanNeeded('unexpected_form', `Rightmove rejected the enquiry: ${result.detail}`);
    }

    const evidence = await this.browser.saveEvidence(propertyPage, `sent-${this.state.data.current.agency_id}`);
    this.state.settleSubmission('sent', { evidence, detail: result.detail });
    this.log('[operator] enquiry confirmed sent');

    // STEPS 10, 11, 12.
    return this.createProbeAndMarkSent(property.url);
  }

  // AN ENQUIRY WHOSE OUTCOME IS UNKNOWN. Handled here, holding the page, rather
  // than by throwing into the run loop — the loop's recovery for a human-needed
  // error is to restart the agency, and restarting an agency whose Send has
  // already been pressed is precisely the duplicate enquiry the whole design
  // exists to prevent.
  //
  // Send is never pressed again on any branch of this. The only ways out are:
  // the page itself now reads as confirmed, the human says they saw the
  // confirmation, or the agency is abandoned.
  async resolveUncertainSubmission(page, layout, detail, propertyUrl) {
    this.state.stage('submitting');
    let reason = detail;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Keep the page itself: it is the only record of wording the operator
      // did not recognise, and it is what teaches it the next variant.
      const dump = await this.browser.saveFormEvidence(page, `unconfirmed-${this.state.data.current.agency_id}`).catch(() => '');
      const released = await this.waitForRelease('uncertain_submission',
        [reason, dump ? `saved: ${dump}` : ''].filter(Boolean).join(' — '));

      if (released === 'abandon') return 'abandoned';

      if (released === 'confirmed_sent') {
        const evidence = await this.browser.saveEvidence(page, `sent-confirmed-${this.state.data.current.agency_id}`).catch(() => '');
        // release() has already settled it; this only attaches the evidence.
        if (this.state.data.current.submission.state !== 'sent') {
          this.state.settleSubmission('sent', { evidence, detail: 'confirmed by the operator', confirmedBy: 'human' });
        } else {
          this.state.data.current.submission.evidence = evidence || this.state.data.current.submission.evidence;
          this.state.save();
        }
        this.log('[operator] operator confirmed the enquiry was sent; continuing to Create probe');
        return this.createProbeAndMarkSent(propertyUrl || this.state.data.current.property_url);
      }

      // Plain release: look at the page again, with no click.
      const seen = await observeSubmissionOutcome(page, { timeout: this.config.timeouts.submitResult, layout })
        .catch(() => ({ outcome: 'uncertain', detail: 'the page could not be read after release' }));
      if (seen.outcome === 'sent') {
        const evidence = await this.browser.saveEvidence(page, `sent-${this.state.data.current.agency_id}`).catch(() => '');
        this.state.settleSubmission('sent', { evidence, detail: seen.detail });
        this.log('[operator] confirmation recognised after release; continuing to Create probe');
        return this.createProbeAndMarkSent(propertyUrl || this.state.data.current.property_url);
      }
      reason = `still not confirmed after release: ${seen.detail}`;
    }
    // Keep the agency paused even after several inconclusive rechecks.
    const released = await this.waitForRelease('uncertain_submission', reason);
    if (released === 'abandon') return 'abandoned';
    if (this.state.data.current.submission.state === 'sent') return this.resumeSentWork();
    return this.resolveUncertainSubmission(page, layout, reason, propertyUrl);
  }

  // STEP 2's tab handling. probe.html already calls window.open on the branch
  // URL as the agency loads, so the usual case is adopting that popup. When the
  // popup was blocked, the explicit button is clicked instead — the spec's
  // "recover safely" path, not an abandoned agency.
  async acquireBranchTab() {
    const branchUrl = this.state.data.current.branch_url;
    const existing = this.browser.rightmoveTabs()
      .find((page) => page.url().split('#')[0] === branchUrl.split('#')[0]);
    if (existing) return existing;
    if (!/^https?:\/\//i.test(branchUrl)) throw new HumanNeeded('agency_page_unavailable', `invalid branch URL: ${branchUrl}`);
    return this.browser.openBackgroundTab(branchUrl);
  }

  // STEP 3 proper. Deterministic first; the model is consulted only when the
  // deterministic pass produced no confident answer at all.
  async selectProperty(branchPage, verified) {
    const read = await readBranchCandidates(branchPage);

    if (read.lettingsOnly) return this.skip('lettings_only', `${read.toRentCount} to rent, 0 for sale`);
    if (read.forSaleCount === 0) return this.skip('no_sales_listings', 'the branch page reports 0 properties for sale');

    const saleCandidates = read.candidates.filter((c) => !c.channel || c.channel === 'RES_BUY');
    if (!saleCandidates.length) {
      if (read.candidates.length === 0 && read.forSaleCount === null) {
        throw new HumanNeeded('agency_page_unavailable', 'the branch page showed no property list at all');
      }
      return this.skip('no_sales_listings', 'no residential sales listings on the branch page');
    }

    const decision = chooseListing(saleCandidates);
    if (decision.chosen) {
      this.log(`[operator] chose ${decision.chosen.propertyType} — ${decision.chosen.address} (${decision.assessment.reason})`);
      return decision.chosen;
    }

    // Every candidate was either unsuitable or unreadable. If some were merely
    // unreadable, ask the model about them; if all were plainly unsuitable
    // (land, commercial), that is a verified ineligibility and a safe skip.
    if (!decision.uncertain.length) {
      const categories = [...new Set(decision.all.map((row) => row.assessment.category))];
      if (categories.every((c) => c === 'land')) return this.skip('no_sales_listings', 'the branch sells land only');
      if (categories.every((c) => c === 'commercial')) return this.skip('no_sales_listings', 'the branch sells commercial property only');
      // Mixed unsuitable types: not a clean, single verified reason. Escalate
      // rather than hard-delete an agency on a judgement call.
      throw new HumanNeeded('uncertain_suitability', `no ordinary residential sale found; categories seen: ${categories.join(', ')}`);
    }

    if (!this.config.aiEnabled) {
      throw new HumanNeeded('uncertain_suitability', 'listing types were unreadable and AI assessment is disabled');
    }
    const screenshot = await this.browser.screenshotBase64(branchPage);
    for (const candidate of decision.uncertain.slice(0, 3)) {
      const assessment = await assessListing({
        model: this.config.aiModel,
        text: `${candidate.propertyType}\n${candidate.address}\n${candidate.price}\n${candidate.text}`,
        screenshotBase64: screenshot,
      });
      this.state.recordAi(assessment.usage);
      if (assessment.verdict === 'suitable') {
        this.log(`[operator] AI accepted ${candidate.address}: ${assessment.reason}`);
        return candidate;
      }
    }
    throw new HumanNeeded('uncertain_suitability', 'neither the deterministic rules nor the model could confirm a suitable residential sale listing');
  }

  // A plain wait between confirmed enquiries. It retries nothing, touches no
  // verification and is not a way around one; it only spaces the batch out.
  // Pause and emergency stop are honoured every quarter second, and the panel
  // shows the countdown so a waiting operator never looks like a hung one.
  async cooldown() {
    const waitMs = cooldownMs(this.config);
    if (waitMs <= 0) return;
    const until = Date.now() + waitMs;
    this.state.setRun({ cooldown_until: new Date(until).toISOString() });
    this.log(`[operator] pacing: waiting ${Math.round(waitMs / 1000)}s before the next agency`);
    try {
      while (Date.now() < until) {
        await this.checkpoint();
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
      }
    } finally {
      this.state.setRun({ cooldown_until: '' });
    }
  }

  // Page-specific waits above establish readiness; this adds a small,
  // interruptible gap only between the major actions.
  async pace() {
    const until = Date.now() + (this.config.actionDelayMs || 0);
    do {
      await this.checkpoint();
      if (Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(200, until - Date.now())));
    } while (Date.now() < until);
  }

  async triageUnknownPage(page) {
    if (!this.config.aiEnabled) return null;
    try {
      const [text, screenshot] = await Promise.all([
        page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => ''),
        this.browser.screenshotBase64(page),
      ]);
      const verdict = await classifyUnknownPage({ model: this.config.aiModel, url: page.url(), text, screenshotBase64: screenshot });
      this.state.recordAi(verdict.usage);
      return verdict;
    } catch (error) {
      this.log('[operator] page triage unavailable:', error.message);
      return null;
    }
  }

  async skip(reasonKey, detail) {
    const label = AUTO_SKIP[reasonKey];
    if (!label) throw new HumanNeeded('uncertain_suitability', detail);
    this.log(`[operator] skipping ${this.state.data.current.agency_name}: ${detail}`);
    await this.browser.closeRightmoveTabs();               // 3.1
    this.state.stage('skipping');
    const page = await this.browser.novusTab();            // 3.2
    const result = await this.prober.skipAgency(label);    // 3.3 → 3.5
    if (!result.ok) throw new HumanNeeded('agency_page_unavailable', `Skip agency failed: ${result.error}`);
    this.state.finishCycle('skipped');
    await this.prober.waitForAgencyLoaded().catch(() => {});  // 3.6
    return 'skipped';
  }

  // STEPS 10–12.
  async createProbeAndMarkSent(propertyUrl) {
    await this.browser.closeRightmoveTabs();               // 10.1
    const page = await this.browser.novusTab();

    // The Prober tab may have drifted; re-open the agency so #url and
    // #create-btn are the controls for THIS agency.
    const current = this.state.data.current;
    if (!/agency_id=/.test(page.url()) || !page.url().includes(encodeURIComponent(current.agency_id))) {
      await this.prober.openAgency(current.agency_id);
    }

    const created = await this.prober.createProbe(propertyUrl);   // 10.3–10.5
    if (!created.ok) throw new HumanNeeded('probe_not_recorded', `Create probe failed after the enquiry was sent: ${created.error}`);
    const probeId = await this.prober.currentProbeId();
    this.state.stage('probe_created', { probe_id: probeId || '', probe_reference: created.reference });
    this.log(`[operator] probe created: ${created.reference}`);

    // STEP 11's pre-flight checks, on the Probe ready screen itself.
    if (created.agency && current.agency_id && created.agency !== current.agency_id) {
      throw new HumanNeeded('probe_not_recorded', `the Probe ready screen shows agency ${created.agency}, expected ${current.agency_id}`);
    }
    if (this.config.identity.email && created.email && created.email !== this.config.identity.email) {
      throw new HumanNeeded('probe_not_recorded', `the probe was stamped with ${created.email}, not the identity the enquiry used`);
    }
    return this.finishMarkSent();
  }

  async finishMarkSent() {
    await this.checkpoint();
    const probeId = this.state.data.current.probe_id || await this.prober.currentProbeId();
    const marked = await this.prober.markAsSent();
    if (!marked.ok) throw new HumanNeeded('probe_not_recorded', marked.error);
    this.state.stage('marked_sent', { marked_sent: true, probe_id: probeId || this.state.data.current.probe_id });

    // "Verify that the actual existing backend records the probe as sent."
    // Read the PROBES row back through the same route the UI used.
    if (probeId) {
      const probe = await this.novus.probe(probeId).then((d) => d.probe).catch(() => null);
      if (!isProbeRecordedAsSent(probe)) {
        throw new HumanNeeded('probe_not_recorded', `PROBES ${probeId} is not observing after Mark as sent (status ${probe?.probe_status || 'unknown'})`);
      }
      this.log(`[operator] NOVUS confirms ${probeId} observing until ${probe.observation_deadline}`);
    } else {
      this.log('[operator] probe_id was not readable from the page; relying on the UI transition only');
    }

    this.state.finishCycle('completed');                   // 12.1
    return 'completed';
  }
}
