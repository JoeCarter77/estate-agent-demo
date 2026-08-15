// lib/schema.mjs — the columns the CODE depends on, per workbook tab.
//
// WHY THIS EXISTS
// createRepo().appendRecord maps a record onto the sheet's header row, so any
// key whose column does not exist is DROPPED WITHOUT ERROR. That is the right
// behaviour at write time (a half-written row is worse than a missing field,
// and it makes new fields forward-compatible), but it is a silent data-loss
// path: the API returns 200, the UI shows the value, and the workbook never
// receives it.
//
// This module makes that failure visible. It declares what each tab must
// contain and lets the verifier report exactly which columns are missing, so
// the gap is found by running a check rather than by noticing months later
// that a column is empty.
//
// Adding a column here does NOT change any write path — it only means the
// verifier will now report it as missing until it is added to the sheet.

// Columns without which a tab cannot do its job at all.
export const REQUIRED_COLUMNS = {
  AGENCIES: [
    'agency_id', 'agency_name', 'website', 'domain', 'location', 'main_phone',
    'known_phone_numbers', 'primary_contact_email', 'other_known_emails',
    'suppression_status', 'created_at', 'updated_at',
  ],
  PROBES: [
    'probe_id', 'probe_reference', 'agency_id', 'portal', 'property_address',
    'property_url', 'property_price', 'property_status', 'enquiry_text',
    'probe_email', 'probe_phone', 'probe_timestamp', 'observation_deadline',
    'probe_status', 'compromised', 'compromise_reason', 'observation_closed_at',
    'created_at', 'updated_at',
  ],
  COMMUNICATIONS: [
    'communication_id', 'agency_id', 'probe_id', 'occurred_at', 'received_at',
    'channel', 'direction', 'communication_type', 'provider', 'provider_event_id',
    'source_identifier_raw', 'source_identifier_normalized', 'raw_content',
    'matching_method', 'match_score', 'match_status', 'automated_or_human',
    'human_contact', 'callback_attempt', 'successful_conversation', 'follow_up',
    'booking_attempt', 'communication_classification', 'manual_review_status',
    'created_at', 'updated_at',
  ],
  INTELLIGENCE: [
    'intelligence_id', 'agency_id', 'probe_id', 'observation_status',
    'observation_deadline', 'auto_acknowledgement', 'first_human_touch',
    'human_lag_hours', 'follow_up_count', 'last_touch_at', 'grade',
    'grade_reason', 'observation_closed_at', 'created_at', 'updated_at',
  ],
  ACTIONS: [
    'action_id', 'agency_id', 'probe_id', 'action_type', 'action_status',
    'priority', 'due_at', 'reason', 'created_at', 'updated_at',
  ],
  RAW_EVENTS: [
    'raw_event_id', 'provider', 'provider_event_id', 'channel', 'event_type',
    'received_at', 'occurred_at', 'source_identifier', 'payload_reference',
    'processing_status', 'processed_communication_id', 'error_message', 'created_at',
  ],
};

// Columns the code WRITES but can operate without. A missing optional column
// means that specific fact is being discarded on every write — a real loss of
// intelligence, but not a broken pipeline. Reported as a warning, not an error.
export const OPTIONAL_COLUMNS = {
  PROBES: [
    // Property evidence captured at probe creation (§3 of the probe brief).
    'property_id', 'property_postcode', 'property_type', 'property_bedrooms',
    'listing_agent_name', 'listing_image_url',
    // Explicit record of whether extraction actually worked for this probe.
    'extraction_status', 'extraction_error',
    'sent_from', 'observation_notes',
  ],
  COMMUNICATIONS: [
    'interaction_id', 'destination_identifier', 'display_name', 'call_status',
    'duration_seconds', 'voicemail_present', 'recording_reference', 'transcript',
    'email_message_id', 'email_thread_id', 'subject', 'body_text',
    'raw_payload_reference', 'intent', 'contact_quality', 'ai_summary',
    'ai_confidence', 'ai_model', 'manual_override', 'override_reason',
  ],
  INTELLIGENCE: [
    'auto_ack_timestamp', 'crm_detected', 'crm_name', 'crm_evidence',
    'first_human_touch_at', 'callback_attempts', 'successful_conversations',
    'voicemail_count', 'inbound_sms_count', 'email_touch_count',
    'contact_attempt_count', 'follow_up_channels', 'days_chased',
    'booking_attempt', 'contact_quality', 'proactive_reactive',
    'persistence_profile', 'channels_used', 'tier', 'tier_reason',
    'sales_angle', 'segment', 'ai_evidence_summary', 'ai_confidence',
    'manual_override', 'override_reason', 'next_action',
  ],
  ACTIONS: ['completed_at', 'owner', 'trigger', 'related_communication_id', 'notes'],
};

// Compares a tab's live header row against the declarations above.
// Returns { tab, ok, missingRequired, missingOptional, unknownInSheet }.
export function checkTabHeader(tab, header) {
  const present = new Set((header || []).map((h) => String(h || '').trim()));
  const required = REQUIRED_COLUMNS[tab] || [];
  const optional = OPTIONAL_COLUMNS[tab] || [];

  const missingRequired = required.filter((c) => !present.has(c));
  const missingOptional = optional.filter((c) => !present.has(c));
  const declared = new Set([...required, ...optional]);
  const unknownInSheet = [...present].filter((c) => c && !declared.has(c));

  return {
    tab,
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
    unknownInSheet,
  };
}

// Checks every declared tab against the live workbook.
// Returns { ok, tabs: [...], errors: [...] }.
export async function verifyWorkbookSchema(repo) {
  const tabs = [];
  const errors = [];
  for (const tab of Object.keys(REQUIRED_COLUMNS)) {
    try {
      const { header } = await repo.getTable(tab);
      tabs.push(checkTabHeader(tab, header));
    } catch (err) {
      // A tab that cannot even be read is a hard failure — most likely it does
      // not exist, which no amount of column-adding will fix.
      errors.push({ tab, error: err?.message || String(err) });
      tabs.push({ tab, ok: false, missingRequired: REQUIRED_COLUMNS[tab], missingOptional: [], unknownInSheet: [] });
    }
  }
  return { ok: errors.length === 0 && tabs.every((t) => t.ok), tabs, errors };
}
