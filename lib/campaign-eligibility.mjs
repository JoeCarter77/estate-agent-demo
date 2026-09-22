// lib/campaign-eligibility.mjs — the NOVUS decision "may this lead enter
// this campaign?". PURE: no I/O, no repo, no fetch. The audience builder
// (lib/campaign-audience.mjs) assembles a context per candidate from tables
// it has already loaded and calls evaluateEligibility(); the push path calls
// it again on the stored snapshot so a lead that became ineligible between
// selection and push is still stopped.
//
// Instantly is never asked whether a lead can be contacted. Its own
// blocklist and skip_if_in_campaign flags are a second line of defence for
// duplicates; the sales-state decisions below are NOVUS's alone.
//
// RULES ARE DATA. Each rule is { code, severity, when(ctx) } and the table
// is evaluated top to bottom; a rule may consult ctx.policy so the same
// table serves an enquiry follow-up campaign and a general one. Add a rule
// by appending to RULES; change its strength by editing severity or the
// policy switch it reads. The status is derived, never set by a rule:
//   any BLOCK   → BLOCKED
//   any WARN    → WARNING (may be pushed only with explicit acknowledgement)
//   otherwise   → READY, with the positive facts recorded as reasons.

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const DAY_MS = 86_400_000;
import { hasVendorDeclaration } from './vendor-intent.mjs';
import { hasPropertyStreet } from './property-reference.mjs';

export const ELIGIBILITY_STATUS = Object.freeze({ READY: 'READY', WARNING: 'WARNING', BLOCKED: 'BLOCKED' });

export const DEFAULT_POLICY = Object.freeze({
  // Days since the last email NOVUS sent (campaign send, manual reply,
  // demo reply or Instantly handoff) below which a lead is "contacted too
  // recently".
  cooling_days: 14,
  // ENQUIRY_FOLLOWUP copy references the probe enquiry; a lead with no
  // completed probe cannot receive it.
  requires_probe: true,
  // Verification gates. VALID is always fine; RISKY is a warning when allowed
  // and a block when not; anything else (INVALID/UNKNOWN/blank) is a block.
  allow_risky_email: false,
  // Generic inboxes (info@, sales@ …) are a warning when allowed, a block
  // when not.
  allow_generic_email: true,
  // Require an owner/director-tier contact.
  require_owner_contact: false,
  // Overlapping automated outreach: another ACTIVE/PAUSED campaign.
  block_active_campaign: true,
  // Sales-state gates.
  block_prior_negative: true,
  block_active_conversation: true,
  block_meeting_booked: true,
  block_active_followup: true,
  // Leads that already bounced anywhere are always blocked; this switch is
  // for a previous *unsubscribe/opt-out* being treated as permanent.
  block_opted_out: true,
});

export function normalisePolicy(input = {}) {
  const out = { ...DEFAULT_POLICY };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    if (typeof DEFAULT_POLICY[key] === 'boolean') out[key] = input[key] === true || upper(input[key]) === 'TRUE';
    else if (typeof DEFAULT_POLICY[key] === 'number') { const n = Number(input[key]); if (Number.isFinite(n) && n >= 0) out[key] = n; }
  }
  return out;
}

// Reason codes, with the operator-facing wording used by the review screen.
export const REASON_LABEL = Object.freeze({
  // blocks
  OPTED_OUT: 'Opted out / unsubscribed',
  DO_NOT_CONTACT: 'Do not contact (agency suppressed or closed)',
  NO_EMAIL: 'No outreach email on file',
  INVALID_EMAIL: 'Email verification is not VALID',
  INVALID_EMAIL_FORMAT: 'Email address has an invalid format',
  RISKY_EMAIL: 'Email verification is RISKY',
  GENERIC_EMAIL: 'Generic inbox (info@, sales@ …)',
  HARD_BOUNCE: 'Email previously bounced',
  DUPLICATE_EMAIL: 'Same address as another selected agency (kept once)',
  DUPLICATE_AGENCY: 'Agency appears more than once in this selection',
  ALREADY_IN_CAMPAIGN: 'Already a member of this campaign',
  IN_ACTIVE_CAMPAIGN: 'In another active campaign',
  RECENTLY_EMAILED: 'Emailed inside the cooling period',
  NEGATIVE_REPLY: 'Previously replied not interested',
  ACTIVE_CONVERSATION: 'In an active manual conversation',
  MEETING_BOOKED: 'Meeting already booked',
  ACTIVE_FOLLOWUP: 'Active sales follow-up in progress',
  MISSING_PROBE: 'No completed probe (campaign copy relies on the enquiry)',
  MISSING_PROPERTY: 'Probe has no valid property reference',
  NO_SELLER_SIGNAL: 'Probe does not explicitly record a property to sell',
  PROBE_COMPROMISED: 'Probe was compromised',
  PROBE_NOT_CLOSED: 'Probe still observing (not closed yet)',
  NOT_OWNER: 'Contact is not an identified owner/director',
  NO_PERSONALISATION: 'No personalisation variables for the probe yet',
  // positive facts
  EMAIL_VALID: 'Email verified VALID',
  EMAIL_RISKY_ALLOWED: 'RISKY email allowed by policy',
  PROBE_COMPLETE: 'Probe complete',
  PROBE_SENT: 'Probe sent',
  NO_PRIOR_OUTREACH: 'Never emailed',
  PRIOR_OUTREACH_OUTSIDE_COOLING: 'Last email outside the cooling period',
  PRIOR_SEQUENCE_COMPLETED: 'Completed a previous sequence (not a fresh lead)',
  PRIOR_CAMPAIGN_MEMBER: 'Was in a previous campaign',
  OWNER_CONTACT: 'Owner/director identified',
  NAMED_CONTACT: 'Named contact',
});

function daysAgo(ms, nowMs) {
  if (!Number.isFinite(ms)) return null;
  return Math.floor((nowMs - ms) / DAY_MS);
}

// ── the rule table ─────────────────────────────────────────────────────────
// `when` returns false (rule does not apply) or true / a detail string.
export const RULES = Object.freeze([
  // Hard suppression first: these never depend on policy.
  { code: 'OPTED_OUT', severity: 'BLOCK', when: (c) => c.policy.block_opted_out && (c.facts.opted_out || c.facts.unsubscribed) },
  { code: 'DO_NOT_CONTACT', severity: 'BLOCK', when: (c) => c.facts.suppressed || ['CLOSED', 'EXCLUDED'].includes(c.facts.pipeline_status) },
  { code: 'HARD_BOUNCE', severity: 'BLOCK', when: (c) => c.facts.bounced },
  { code: 'NO_EMAIL', severity: 'BLOCK', when: (c) => !c.facts.email },
  { code: 'INVALID_EMAIL_FORMAT', severity: 'BLOCK', when: (c) => c.facts.probe_call_campaign && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.facts.email) },
  { code: 'INVALID_EMAIL', severity: 'BLOCK', when: (c) => Boolean(c.facts.email) && !['VALID', 'RISKY'].includes(c.facts.verification_status) },
  { code: 'RISKY_EMAIL', severity: 'BLOCK', when: (c) => c.facts.verification_status === 'RISKY' && !c.policy.allow_risky_email },
  { code: 'RISKY_EMAIL', severity: 'WARN', when: (c) => c.facts.verification_status === 'RISKY' && c.policy.allow_risky_email },
  { code: 'GENERIC_EMAIL', severity: 'BLOCK', when: (c) => c.facts.generic_email && !c.policy.allow_generic_email },
  { code: 'GENERIC_EMAIL', severity: 'WARN', when: (c) => c.facts.generic_email && c.policy.allow_generic_email },
  { code: 'NOT_OWNER', severity: 'BLOCK', when: (c) => c.policy.require_owner_contact && !c.facts.owner_contact },
  // Duplicates inside the selection and against the campaign itself.
  { code: 'DUPLICATE_EMAIL', severity: 'BLOCK', when: (c) => c.facts.duplicate_email },
  { code: 'DUPLICATE_AGENCY', severity: 'BLOCK', when: (c) => c.facts.duplicate_agency },
  { code: 'ALREADY_IN_CAMPAIGN', severity: 'BLOCK', when: (c) => c.facts.in_this_campaign },
  { code: 'IN_ACTIVE_CAMPAIGN', severity: 'BLOCK', when: (c) => c.facts.in_other_active_campaign && c.policy.block_active_campaign },
  { code: 'IN_ACTIVE_CAMPAIGN', severity: 'WARN', when: (c) => c.facts.in_other_active_campaign && !c.policy.block_active_campaign },
  // Sales state.
  { code: 'MEETING_BOOKED', severity: 'BLOCK', when: (c) => c.policy.block_meeting_booked && c.facts.meeting_booked },
  { code: 'NEGATIVE_REPLY', severity: 'BLOCK', when: (c) => c.policy.block_prior_negative && c.facts.negative_reply },
  { code: 'NEGATIVE_REPLY', severity: 'WARN', when: (c) => !c.policy.block_prior_negative && c.facts.negative_reply },
  { code: 'ACTIVE_CONVERSATION', severity: 'BLOCK', when: (c) => c.policy.block_active_conversation && c.facts.active_conversation },
  { code: 'ACTIVE_CONVERSATION', severity: 'WARN', when: (c) => !c.policy.block_active_conversation && c.facts.active_conversation },
  { code: 'ACTIVE_FOLLOWUP', severity: 'BLOCK', when: (c) => c.policy.block_active_followup && c.facts.active_followup },
  { code: 'ACTIVE_FOLLOWUP', severity: 'WARN', when: (c) => !c.policy.block_active_followup && c.facts.active_followup },
  // Timing.
  {
    code: 'RECENTLY_EMAILED', severity: 'WARN',
    when: (c) => c.facts.last_emailed_days !== null && c.facts.last_emailed_days < c.policy.cooling_days
      ? `LAST_EMAIL_${c.facts.last_emailed_days}_DAYS_AGO` : false,
  },
  // Probe dependency.
  { code: 'MISSING_PROBE', severity: 'BLOCK', when: (c) => c.policy.requires_probe && !c.facts.probe_sent },
  { code: 'MISSING_PROPERTY', severity: 'BLOCK', when: (c) => c.facts.probe_call_campaign && !c.facts.property_reference },
  { code: 'NO_SELLER_SIGNAL', severity: 'BLOCK', when: (c) => c.facts.probe_call_campaign && !c.facts.seller_signal },
  { code: 'PROBE_NOT_CLOSED', severity: 'BLOCK', when: (c) => c.facts.probe_call_campaign && !c.facts.probe_complete },
  { code: 'PROBE_COMPROMISED', severity: 'BLOCK', when: (c) => c.policy.requires_probe && c.facts.probe_compromised },
  { code: 'PROBE_NOT_CLOSED', severity: 'WARN', when: (c) => !c.facts.probe_call_campaign && c.policy.requires_probe && c.facts.probe_sent && !c.facts.probe_complete },
  { code: 'NO_PERSONALISATION', severity: 'WARN', when: (c) => !c.facts.probe_call_campaign && c.policy.requires_probe && c.facts.probe_complete && !c.facts.personalisation_ready },
]);

// Positive facts, recorded when a lead is READY so the review screen can say
// WHY it is safe, not just that it is.
const POSITIVE = Object.freeze([
  { code: 'EMAIL_VALID', when: (c) => c.facts.verification_status === 'VALID' },
  { code: 'EMAIL_RISKY_ALLOWED', when: (c) => c.facts.verification_status === 'RISKY' },
  { code: 'PROBE_COMPLETE', when: (c) => c.facts.probe_complete },
  { code: 'PROBE_SENT', when: (c) => c.facts.probe_sent && !c.facts.probe_complete },
  { code: 'NO_PRIOR_OUTREACH', when: (c) => c.facts.last_emailed_days === null && !c.facts.prior_campaign_count },
  { code: 'PRIOR_OUTREACH_OUTSIDE_COOLING', when: (c) => c.facts.last_emailed_days !== null && c.facts.last_emailed_days >= c.policy.cooling_days },
  { code: 'PRIOR_SEQUENCE_COMPLETED', when: (c) => c.facts.prior_sequence_completed },
  { code: 'PRIOR_CAMPAIGN_MEMBER', when: (c) => c.facts.prior_campaign_count > 0 && !c.facts.prior_sequence_completed },
  { code: 'OWNER_CONTACT', when: (c) => c.facts.owner_contact },
  { code: 'NAMED_CONTACT', when: (c) => !c.facts.owner_contact && c.facts.named_contact },
]);

// ── fact derivation ────────────────────────────────────────────────────────
// Everything a rule may ask is computed ONCE here from the candidate's raw
// evidence. Rules never touch raw rows, so a column rename is a one-line fix.
export function deriveFacts(candidate, { nowMs = Date.now() } = {}) {
  const agency = candidate.agency || {};
  const contact = candidate.contact || {};
  const probe = candidate.probe || null;
  const replies = candidate.replyEvents || [];
  const actions = candidate.actions || [];
  const events = candidate.campaignEvents || [];
  const memberships = candidate.memberships || [];
  const calls = candidate.calls || [];
  const email = text(contact.email).toLowerCase();
  const callBookedMeeting = calls.some((row) => upper(row.outcome) === 'BOOKED_MEETING');
  const callDoNotCall = calls.some((row) => ['DO_NOT_CALL'].includes(upper(row.outcome)));

  const classifications = replies.map((row) => upper(row.classification));
  const optedOut = replies.some((row) => upper(row.suppression_type) === 'PERMANENT' || upper(row.classification) === 'OPT_OUT');
  const unsubscribed = events.some((row) => upper(row.event_type) === 'LEAD_UNSUBSCRIBED')
    || memberships.some((row) => text(row.unsubscribed_at) || upper(row.instantly_lead_status) === 'UNSUBSCRIBED');
  const bounced = events.some((row) => upper(row.event_type) === 'EMAIL_BOUNCED')
    || memberships.some((row) => text(row.bounced_at) || upper(row.instantly_lead_status) === 'BOUNCED');

  const stage = upper(candidate.stage);
  // Cold emails actually sent: the CAMPAIGN_EVENTS ledger is the record.
  // Without ledger rows (a campaign not yet imported) the membership counter,
  // the live execution read and — last — the legacy OUTBOUND handoff stand in,
  // each as a fallback and never added on top of the ledger.
  const ledgerSends = events.filter((row) => upper(row.event_type) === 'EMAIL_SENT').map((row) => Date.parse(text(row.occurred_at))).filter(Number.isFinite);
  const membershipSends = memberships.reduce((n, row) => n + (Number(row.emails_sent_count) || 0), 0);
  const executionSends = Number(candidate.execution?.emails_sent_count) || 0;
  const fallbackTimes = [
    ...memberships.filter((row) => upper(row.last_event_type) === 'EMAIL_SENT').map((row) => Date.parse(text(row.last_event_at))),
    ...(candidate.execution?.last_email_sent_at ? [Date.parse(text(candidate.execution.last_email_sent_at))] : []),
    // A handoff to the legacy single campaign counts as contact: Instantly
    // will have mailed it, and this module cannot see /emails.
    ...(candidate.outbound?.instantly_added_at ? [Date.parse(text(candidate.outbound.instantly_added_at))] : []),
  ].filter(Number.isFinite);
  const priorEmailCount = ledgerSends.length || Math.max(membershipSends, executionSends, fallbackTimes.length ? 1 : 0);
  // "Last emailed" also counts NOVUS's manual sends: a reply Joe wrote last
  // week is contact for the cooling period, though not a cold email.
  const contactTimes = [
    ...(ledgerSends.length ? ledgerSends : fallbackTimes),
    ...(candidate.salesMessages || []).filter((row) => upper(row.send_outcome) === 'SENT').map((row) => Date.parse(text(row.sent_at || row.created_at))),
    ...events.filter((row) => upper(row.event_type) === 'MANUAL_REPLY_SENT').map((row) => Date.parse(text(row.occurred_at))),
  ].filter(Number.isFinite);
  const lastEmailedMs = contactTimes.length ? Math.max(...contactTimes) : null;

  const activeFollowup = actions.some((row) => ['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'].includes(upper(row.action_status))
    && ['CALL_PROSPECT', 'RETRY_CALL', 'HUMAN_REPLY', 'BOOK_MEETING', 'SEND_INFORMATION', 'PREPARE_MEETING', 'FOLLOW_UP'].includes(upper(row.action_type)));

  const localPart = email.split('@')[0] || '';
  const genericEmail = candidate.generic_email !== undefined
    ? Boolean(candidate.generic_email)
    : upper(contact.contact_type) === 'GENERIC' || /^(info|sales|enquiries|enquiry|hello|admin|office|contact|lettings|mail|team|reception|valuations)$/.test(localPart);
  const ownerContact = upper(contact.contact_type) === 'OWNER_DIRECT' || /\b(owner|director|partner|principal|managing|md|ceo|founder|proprietor)\b/i.test(text(contact.role));
  const namedContact = Boolean(text(contact.name)) && !genericEmail;

  // PROBES.probe_status lifecycle is draft -> observing -> closed (lowercase
  // in the workbook). "Sent" is enough for copy that references the enquiry;
  // "complete" (closed) is what the diagnosis/personalisation needs.
  const probeStatus = upper(probe?.probe_status);
  const probeSent = ['OBSERVING', 'CLOSED'].includes(probeStatus) && Boolean(text(probe?.probe_timestamp || probe?.created_at));
  const probeComplete = probeStatus === 'CLOSED';
  const probeCompromised = upper(probe?.compromised) === 'TRUE';

  return {
    email,
    verification_status: upper(contact.verification_status || agency.email_verification_status),
    generic_email: genericEmail,
    owner_contact: ownerContact,
    named_contact: namedContact,
    pipeline_status: upper(agency.current_pipeline_status),
    suppressed: upper(agency.suppression_status) === 'SUPPRESSED',
    opted_out: optedOut,
    unsubscribed: unsubscribed,
    bounced,
    negative_reply: classifications.includes('NOT_INTERESTED') || stage === 'NOT_INTERESTED' || events.some((row) => upper(row.event_type) === 'LEAD_NOT_INTERESTED')
      || memberships.some((row) => ['NOT_INTERESTED', 'WRONG_PERSON', 'LOST'].includes(upper(row.interest_status))),
    meeting_booked: stage === 'MEETING_BOOKED' || upper(agency.current_pipeline_status) === 'MEETING_BOOKED' || Boolean(text(candidate.demo?.meeting_booked_at))
      || memberships.some((row) => text(row.meeting_booked_at)) || callBookedMeeting,
    do_not_call: callDoNotCall,
    // Any stage past a genuine reply is a manual sales thread — including
    // the demo-sent stages, where Joe has answered and is waiting — and so is
    // an Instantly "interested" mark or a positively classified reply.
    active_conversation: ['REPLIED_NEEDS_HUMAN', 'MEETING_INTENT', 'DEMO_REQUESTED', 'MANUAL_REPLY_SENT_WAITING', 'DEMO_FOLLOWUP_SENT', 'DEMO_ENGAGED', 'DEMO_OPENED', 'DEMO_SENT_UNOPENED'].includes(stage)
      || classifications.some((c) => c === 'POSITIVE_SEND_DEMO' || c === 'POSITIVE_MEETING' || c === 'CALL_REQUESTED')
      || events.some((row) => ['LEAD_INTERESTED', 'LEAD_MEETING_BOOKED'].includes(upper(row.event_type)))
      || memberships.some((row) => ['INTERESTED', 'MEETING_BOOKED', 'MEETING_COMPLETED', 'WON'].includes(upper(row.interest_status))),
    active_followup: activeFollowup || stage === 'CALL_DUE',
    last_emailed_at: lastEmailedMs !== null ? new Date(lastEmailedMs).toISOString() : '',
    last_emailed_days: daysAgo(lastEmailedMs, nowMs),
    prior_email_count: priorEmailCount,
    replied_before: replies.length > 0 || events.some((row) => upper(row.event_type) === 'REPLY_RECEIVED'),
    positive_reply: classifications.some((c) => c === 'POSITIVE_SEND_DEMO' || c === 'POSITIVE_MEETING' || c === 'CALL_REQUESTED') || events.some((row) => ['LEAD_INTERESTED', 'LEAD_MEETING_BOOKED'].includes(upper(row.event_type))),
    probe_sent: probeSent,
    probe_call_campaign: upper(candidate.campaign?.campaign_type) === 'PROBE_FIVE_MINUTE_CALL',
    property_reference: hasPropertyStreet(probe),
    seller_signal: hasVendorDeclaration(probe),
    probe_complete: probeComplete,
    probe_compromised: probeCompromised,
    personalisation_ready: Boolean(candidate.personalisation),
    in_this_campaign: memberships.some((row) => text(row.campaign_id) === text(candidate.campaign?.campaign_id) && upper(row.member_status) !== 'EXCLUDED'),
    // A conflict is a lead that can still RECEIVE mail from another
    // campaign: the campaign is live (or merely paused) and the lead's own
    // sequence has not finished, bounced or unsubscribed. A lead whose old
    // sequence completed is not in conflict — its history is what the
    // cooling and reply rules look at instead.
    in_other_active_campaign: memberships.some((row) => text(row.campaign_id) !== text(candidate.campaign?.campaign_id)
      && ['ACTIVE', 'PAUSED'].includes(upper(row.campaign_status)) && ['SELECTED', 'PUSHED'].includes(upper(row.member_status))
      && !['COMPLETED', 'BOUNCED', 'UNSUBSCRIBED', 'SKIPPED'].includes(upper(row.instantly_lead_status))),
    prior_sequence_completed: memberships.some((row) => text(row.campaign_id) !== text(candidate.campaign?.campaign_id) && upper(row.instantly_lead_status) === 'COMPLETED'),
    prior_campaign_count: new Set(memberships.filter((row) => text(row.campaign_id) !== text(candidate.campaign?.campaign_id) && upper(row.member_status) !== 'EXCLUDED').map((row) => text(row.campaign_id))).size,
    duplicate_email: Boolean(candidate.duplicate_email),
    duplicate_agency: Boolean(candidate.duplicate_agency),
    stage,
  };
}

export function evaluateEligibility(candidate, { policy = DEFAULT_POLICY, nowMs = Date.now() } = {}) {
  const normalised = normalisePolicy(policy);
  const facts = candidate.facts || deriveFacts(candidate, { nowMs });
  const ctx = { facts, policy: normalised };
  const blocks = [];
  const warnings = [];
  const seen = new Set();
  for (const rule of RULES) {
    const hit = rule.when(ctx);
    if (!hit) continue;
    const code = rule.code;
    const key = `${rule.severity}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = typeof hit === 'string' ? [code, hit] : [code];
    if (rule.severity === 'BLOCK') blocks.push(...entry); else warnings.push(...entry);
  }
  let status = ELIGIBILITY_STATUS.READY;
  if (blocks.length) status = ELIGIBILITY_STATUS.BLOCKED;
  else if (warnings.length) status = ELIGIBILITY_STATUS.WARNING;
  const positives = status === ELIGIBILITY_STATUS.BLOCKED ? [] : POSITIVE.filter((p) => p.when(ctx)).map((p) => p.code);
  const reasons = status === ELIGIBILITY_STATUS.BLOCKED ? blocks : [...warnings, ...positives];
  return { status, reasons, blocks, warnings, facts, policy: normalised };
}

// Count reasons across a set of evaluated candidates for the review screen.
export function summariseEligibility(evaluated) {
  const counts = { total: evaluated.length, READY: 0, WARNING: 0, BLOCKED: 0, reasons: {} };
  for (const item of evaluated) {
    counts[item.status] = (counts[item.status] || 0) + 1;
    const codes = item.status === 'BLOCKED' ? item.blocks : item.warnings;
    for (const code of new Set(codes.filter((c) => REASON_LABEL[c]))) counts.reasons[code] = (counts.reasons[code] || 0) + 1;
  }
  counts.eligible = counts.READY;
  counts.reason_breakdown = Object.entries(counts.reasons)
    .map(([code, count]) => ({ code, count, label: REASON_LABEL[code] || code, severity: RULES.find((r) => r.code === code)?.severity || 'WARN' }))
    .sort((a, b) => b.count - a.count);
  return counts;
}

export const _internal = { POSITIVE, daysAgo };
