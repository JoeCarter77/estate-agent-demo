// The founding audiences are private Vercel Production configuration. Never
// bundle local cohort files or send the complete ID lists to the browser.

const COHORTS = Object.freeze({
  FOUNDING_PILOT_OUTCOME: ['A1 · outcome-led', 'A1', 75],
  FOUNDING_PILOT_OUTCOME_UPFRONT: ['A2 · refund upfront', 'A2', 75],
  FOUNDING_PILOT_PROBE: ['B · probe-led', 'B', 55],
});

export async function preparedCohort(type, env = process.env) {
  const entry = COHORTS[String(type || '').toUpperCase()];
  if (!entry) return null;
  const [label, key, expectedCount] = entry;
  const names = ['NOVUS_FOUNDING_COHORT_A1_IDS', 'NOVUS_FOUNDING_COHORT_A2_IDS', 'NOVUS_FOUNDING_COHORT_B_IDS'];
  if (names.some((name) => !env[name])) throw new Error('Private founding cohorts are not configured; campaign creation is blocked');
  const groups = names.map((name) => String(env[name]).split(',').map((id) => id.trim()).filter(Boolean));
  const counts = [75, 75, 55];
  if (groups.some((ids, i) => !Array.isArray(ids) || ids.length !== counts[i]
    || ids.some((id) => typeof id !== 'string' || !/^ag[-_][a-zA-Z0-9_-]+$/.test(id))
    || new Set(ids).size !== counts[i])
    || new Set(groups.flat()).size !== 205) {
    throw new Error('Private founding cohort configuration is incomplete or overlapping; campaign creation is blocked');
  }
  return { label, ids: groups[['A1', 'A2', 'B'].indexOf(key)], count: expectedCount };
}
