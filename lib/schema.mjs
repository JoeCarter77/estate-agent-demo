// lib/schema.mjs — canonical in-repo definition of the INTELLIGENCE tab header.
//
// WHY THIS FILE EXISTS
// lib/sheets.mjs maps records onto the LIVE sheet's header row:
//   appendRecord  -> header.map((key) => obj[key] ?? '')
//   updateById    -> header.map((key) => merged[key] ?? '')
// Any key that is not a column in the live header is silently dropped — no
// error, no warning, no partial write. Adding a field to the recompute patch
// is therefore NOT sufficient to make it persist; the live workbook header
// must contain the column too.
//
// Before this file, the header existed in exactly two places, both of them
// hermetic test fixtures, and nowhere authoritative. That made "which columns
// does INTELLIGENCE actually have?" unanswerable from the repo and let
// computed values be dropped unnoticed (contact_attempt_count was written for
// months into a column that did not exist).
//
// This is the single in-repo source of truth. The self-tests build their fake
// sheets from it, so a field added to the patch but missing here fails the
// tests instead of silently vanishing in production.
//
// ── ACTION REQUIRED IN THE LIVE WORKBOOK ────────────────────────────────────
// The live NOVUS_Data_V1_Master_v2 INTELLIGENCE tab must be given the columns
// appended below (everything from contact_attempt_count onward) before those
// values will persist in production. Append them to the END of the existing
// header row — never insert mid-row, which would shift existing data. Column
// ORDER is otherwise irrelevant: the repo maps strictly by header name.

export const INTELLIGENCE_HEADER = [
  // ── identity ──
  'intelligence_id',
  'agency_id',
  'probe_id',

  // ── observation window state ──
  'observation_status',
  'observation_deadline',

  // ── evidence (Source Master §9/§11/§18) ──
  'auto_acknowledgement',
  'auto_ack_timestamp',
  'crm_detected',
  'crm_name',
  'crm_evidence',
  'first_human_touch',
  'first_human_touch_at',
  'human_lag_hours',
  'callback_attempts',
  'successful_conversations',
  'voicemail_count',
  'inbound_sms_count',
  'email_touch_count',
  'follow_up_count',
  'follow_up_channels',
  'last_touch_at',
  'days_chased',
  'booking_attempt',
  'contact_quality',
  'proactive_reactive',
  'persistence_profile',
  'channels_used',

  // ── official decision (§10 grading, §20 tier) ──
  'grade',
  'grade_reason',
  'tier',
  'tier_reason',
  // The Master's "primary sales angle". Canonical column for the Sales
  // Strategy Engine's `sales_focus` output — one concept, one column, one
  // producer (lib/sales-strategy.mjs). Deliberately not renamed.
  'sales_angle',
  'segment',

  // ── AI/override layer (§19) ──
  'ai_evidence_summary',
  'ai_confidence',
  'manual_override',
  'override_reason',

  'observation_closed_at',
  'created_at',
  'updated_at',

  // ── appended: columns the code already computes but the live sheet has
  // not yet been given. Everything below this line must be added to the live
  // INTELLIGENCE tab before it will persist. ──

  // Computed by lib/observation.mjs since the 30-minute grouping rule landed;
  // previously written to a column that did not exist and silently dropped.
  'contact_attempt_count',

  // Sales Strategy Engine (lib/sales-strategy.mjs). Seven of the eight
  // strategy outputs; the eighth, sales_focus, persists into sales_angle above.
  'observed_problem',
  'commercial_implication',
  'discovery_focus',
  'demo_type',
  'email_strategy',
  'phone_strategy',
  'next_action',
];
