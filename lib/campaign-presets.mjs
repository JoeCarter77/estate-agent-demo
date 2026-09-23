// Locked campaign presets: campaign types whose name, copy, delays and safety
// policy are fixed in code. They share one behaviour — explicit agency cohort,
// strict eligibility, provider-side copy check before push, member-scoped reply
// matching, deterministic reply classification, and CRITICAL call actions for
// owners who ask to talk. Anything else (GENERAL, ENQUIRY_FOLLOWUP) is free-form.
import { PROBE_CALL_CAMPAIGN_NAME, PROBE_CALL_CAMPAIGN_TYPE, PROBE_CALL_SEQUENCE, PROBE_CALL_SCRIPT } from './probe-call-campaign.mjs';
import {
  FOUNDING_OUTCOME_TYPE, FOUNDING_OUTCOME_NAME, FOUNDING_OUTCOME_SEQUENCE,
  FOUNDING_OUTCOME_UPFRONT_TYPE, FOUNDING_OUTCOME_UPFRONT_NAME, FOUNDING_OUTCOME_UPFRONT_SEQUENCE,
  FOUNDING_PROBE_TYPE, FOUNDING_PROBE_NAME, FOUNDING_PROBE_SEQUENCE, FOUNDING_CALL_SCRIPT,
} from './founding-pilot-campaign.mjs';

const upper = (value) => String(value ?? '').trim().toUpperCase();

// `cohort` groups presets that form one experiment: an agency may be a member
// of only one campaign per cohort group, whatever that campaign's status.
export const CAMPAIGN_PRESETS = Object.freeze({
  [PROBE_CALL_CAMPAIGN_TYPE]: Object.freeze({ type: PROBE_CALL_CAMPAIGN_TYPE, label: 'Probe-led 5-minute call', name: PROBE_CALL_CAMPAIGN_NAME, sequence: PROBE_CALL_SEQUENCE, requires_probe: true, forbids_probe: false, cohort: '', call_script: PROBE_CALL_SCRIPT }),
  [FOUNDING_OUTCOME_TYPE]: Object.freeze({ type: FOUNDING_OUTCOME_TYPE, label: 'Founding pilot · A1 outcome-led (no probe)', name: FOUNDING_OUTCOME_NAME, sequence: FOUNDING_OUTCOME_SEQUENCE, requires_probe: false, forbids_probe: true, cohort: 'FOUNDING_PILOT', call_script: FOUNDING_CALL_SCRIPT }),
  [FOUNDING_OUTCOME_UPFRONT_TYPE]: Object.freeze({ type: FOUNDING_OUTCOME_UPFRONT_TYPE, label: 'Founding pilot · A2 outcome-led, refund upfront (no probe)', name: FOUNDING_OUTCOME_UPFRONT_NAME, sequence: FOUNDING_OUTCOME_UPFRONT_SEQUENCE, requires_probe: false, forbids_probe: true, cohort: 'FOUNDING_PILOT', call_script: FOUNDING_CALL_SCRIPT }),
  [FOUNDING_PROBE_TYPE]: Object.freeze({ type: FOUNDING_PROBE_TYPE, label: 'Founding pilot · B probe-led', name: FOUNDING_PROBE_NAME, sequence: FOUNDING_PROBE_SEQUENCE, requires_probe: true, forbids_probe: false, cohort: 'FOUNDING_PILOT', call_script: FOUNDING_CALL_SCRIPT }),
});

export function lockedPreset(campaignType) { return CAMPAIGN_PRESETS[upper(campaignType)] || null; }
export function isLockedCampaignType(campaignType) { return Boolean(lockedPreset(campaignType)); }
export function presetForCampaignName(name) {
  return Object.values(CAMPAIGN_PRESETS).find((preset) => preset.name === String(name ?? '').trim()) || null;
}

export function isPresetSequence(preset, sequence) {
  return Boolean(preset) && JSON.stringify(sequence) === JSON.stringify(preset.sequence);
}

// Instantly may hand the body back with its own markup (<div>/<p> wrappers,
// entities) — compare the words, not the HTML, on both sides.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', rsquo: '’', lsquo: '‘' };
export function comparableBody(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/\s+/g, ' ').trim();
}

// The Instantly draft must carry exactly the approved copy, threading, delays
// and stop-on-reply before any lead is added to it.
export function isMatchingInstantlyPresetCampaign(preset, remote) {
  if (!preset || !remote || remote.name !== preset.name || remote.stop_on_reply !== true || Number(remote.status) !== 0) return false;
  const steps = remote.sequences?.[0]?.steps || [];
  const expectedSteps = preset.sequence.steps;
  if (steps.length !== expectedSteps.length) return false;
  return steps.every((step, index) => {
    const expected = expectedSteps[index];
    const variant = step.variants?.[0];
    return step.variants?.length === 1 && comparableBody(variant?.subject) === comparableBody(expected.variants[0].subject)
      && comparableBody(variant?.body) === comparableBody(expected.variants[0].body) && Number(step.delay) === (expectedSteps[index + 1]?.delay_days || 0)
      && step.delay_unit === 'days';
  });
}

// Browser-safe summary for the campaign wizard.
export function presetEnums() {
  return Object.fromEntries(Object.values(CAMPAIGN_PRESETS).map((p) => [p.type, { label: p.label, name: p.name, sequence: p.sequence, requires_probe: p.requires_probe }]));
}
