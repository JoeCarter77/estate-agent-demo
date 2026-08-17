// lib/problem.mjs — deterministic "Specific Problem" derivation.
//
// Pure function only: turns the real engine's official A-H grade (lib/grading.mjs)
// plus its evidence rollup into a single, human-readable problem statement for the
// Demo OS. This is NOT a second grading implementation and NOT AI-generated copy —
// it is a fixed lookup from grade -> problem template, filled in with real evidence
// numbers already computed upstream. It never inspects raw communications and never
// invents a number that isn't present in the evidence it was given.
//
// Per NOVUS Demo System Reference (Aug 2026): A/B (strong front desk) deliberately do
// NOT get a Core problem invented for them — Core's response-gap story doesn't apply,
// and the real opportunity (if any) lives outside Core's evidence (e.g. database
// reactivation), which this module has no data to assert. 'pending' and any
// unrecognised grade return a safe unknown state rather than guessing.

function fmtHours(hrs) {
  if (typeof hrs !== 'number' || Number.isNaN(hrs)) return null;
  if (hrs < 1) return 'under an hour';
  const rounded = Math.round(hrs);
  return rounded === 1 ? '1 hour' : `${rounded} hours`;
}

const UNKNOWN = { key: null, statement: null };

// { grade: string, evidence: object|null } -> { key, statement }
export function deriveProblem({ grade, evidence }) {
  if (!grade) return UNKNOWN;

  const lagText = fmtHours(evidence?.humanLagHours);
  const lagClause = lagText ? ` (first human reply in ${lagText})` : '';

  switch (grade) {
    case 'C':
    case 'D':
      return {
        key: 'fast_response_no_follow_up',
        statement: `A human responded quickly${lagClause} — then nothing. No genuine follow-up after the first reply, so the enquiry was left to go cold.`,
      };

    case 'E':
      return {
        key: 'slow_response_with_follow_up',
        statement: `A human eventually responded${lagClause}, later than it should have taken, though there was at least one genuine follow-up after that.`,
      };

    case 'F':
      return {
        key: 'slow_response_no_follow_up',
        statement: `A human responded slowly${lagClause}, and there was no genuine follow-up after that single reply.`,
      };

    case 'G':
      return {
        key: 'automated_acknowledgement_only',
        statement: 'This enquiry only ever received an automated acknowledgement — no human contact was observed on any channel.',
      };

    case 'H':
      return {
        key: 'complete_miss',
        statement: 'This enquiry received no meaningful response on any channel before the observation window closed — a complete miss.',
      };

    case 'A':
    case 'B':
      return {
        key: 'strong_front_desk',
        statement: 'The front desk responded fast and followed up genuinely — there is no Core response-gap problem here. Any further opportunity sits outside enquiry handling (e.g. the existing database), which this evidence cannot speak to.',
      };

    case 'pending':
    default:
      return UNKNOWN;
  }
}
