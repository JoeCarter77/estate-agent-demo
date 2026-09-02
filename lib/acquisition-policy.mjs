// Central deterministic acquisition timing policy. Durations are deliberately
// plain milliseconds: this phase reuses stored UTC timestamps and does not
// invent a working-hours calendar.
export const HOUR_MS = 60 * 60 * 1000;

export const ACQUISITION_POLICY = Object.freeze({
  demoUnopenedFollowupMs: 24 * HOUR_MS,
  demoOpenedFollowupMs: 24 * HOUR_MS,
  afterDemoFollowupCallMs: 48 * HOUR_MS,
  afterManualReplyFollowupMs: 48 * HOUR_MS,
  callNoAnswerRetryMs: 48 * HOUR_MS,
  outOfOfficeCheckpointMs: 48 * HOUR_MS,
  firstEmailCheckpointMs: 24 * HOUR_MS,
  sequenceCheckpointMs: 7 * 24 * HOUR_MS,
});

export function addMs(iso, delayMs) {
  const value = Date.parse(String(iso || ''));
  return Number.isFinite(value) ? new Date(value + delayMs).toISOString() : '';
}
