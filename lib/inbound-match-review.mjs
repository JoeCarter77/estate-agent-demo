// Read-only production review over unresolved inbound COMMUNICATIONS.
//
// The Command Centre uses this as its communication-resolution inbox. It loads
// the three identity tables once, runs the same deterministic matcher used by
// live ingestion, and returns enough context for a human to resolve the small
// remainder without opening Twilio or the raw spreadsheet.

import { matchInboundCommunication } from './inbound-matching.mjs';

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 150;
const MAX_DAYS = 180;
const MAX_LIMIT = 500;
const PREVIEW_LENGTH = 500;

function queryValue(req, key) {
  const direct = req.query?.[key];
  if (Array.isArray(direct)) return direct[0];
  if (direct !== undefined) return direct;
  try {
    return new URL(req.url || '', 'https://novus.invalid').searchParams.get(key);
  } catch {
    return undefined;
  }
}

function boundedPositiveInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function text(value) {
  return String(value ?? '').trim();
}

function preview(comm) {
  return text(comm.transcript || comm.body_text || comm.raw_content)
    .replace(/\s+/g, ' ')
    .slice(0, PREVIEW_LENGTH);
}

function isRecent(comm, cutoff) {
  const timestamp = new Date(comm.occurred_at || comm.received_at).getTime();
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}

// A row is unresolved only when it is missing an identity — legacy
// match_status values (HIGH, MEDIUM, HIGH_AGENCY_OUT_OF_WINDOW, ...) and a
// blank matching_method (never populated on pre-matcher rows) do not, on
// their own, put an already-fully-identified row back into the queue.
function isUnresolved(comm) {
  return !text(comm.probe_id) || !text(comm.agency_id);
}

function proposedStatus(match) {
  if (match.matching_method === 'conflict') return 'conflict';
  if (match.match_status === 'ambiguous') return 'ambiguous';
  if (match.match_status === 'matched' && match.agency_id && match.probe_id) return 'recoverable';
  return 'unmatched';
}

function evidenceReason(match) {
  return {
    confidence: Number(match.match_score) || 0,
    signals: (match.evidence || []).map((item) => {
      const identities = item.probe_id
        ? `probe=${item.probe_id}`
        : item.agency_ids?.length ? `agencies=${item.agency_ids.join('|')}` : '';
      return [item.method || item.type, identities, item.detail].filter(Boolean).join(': ');
    }),
  };
}

function matcherInput(comm) {
  return {
    channel: comm.channel,
    sender_email: comm.channel === 'email' ? comm.source_identifier_raw : '',
    sender_phone: ['sms', 'voice'].includes(comm.channel) ? comm.source_identifier_raw : '',
    display_name: comm.display_name,
    subject: comm.subject,
    body_text: comm.body_text,
    raw_content: comm.raw_content,
    transcript: comm.transcript,
    agency_id_hint: comm.agency_id,
  };
}

function isMissingIdentity(comm) {
  return !text(comm.agency_id) || !text(comm.probe_id);
}

function byId(records, key) {
  return new Map(records.map((record) => [text(record.obj[key]), record.obj]).filter(([id]) => id));
}

export function inboundMatchDryRunOptions(req) {
  return {
    days: boundedPositiveInteger(queryValue(req, 'days'), DEFAULT_DAYS, MAX_DAYS),
    limit: boundedPositiveInteger(queryValue(req, 'limit'), DEFAULT_LIMIT, MAX_LIMIT),
  };
}

export async function evaluateInboundMatchCandidates(repo, {
  days = DEFAULT_DAYS,
  limit = DEFAULT_LIMIT,
  now = new Date(),
  candidateMode = 'unresolved',
} = {}) {
  const [communications, agencies, probes] = await Promise.all([
    repo.getRecords('COMMUNICATIONS', 'communication_id'),
    repo.getRecords('AGENCIES', 'agency_id'),
    repo.getRecords('PROBES', 'probe_id'),
  ]);
  const cache = new Map([
    ['COMMUNICATIONS', communications],
    ['AGENCIES', agencies],
    ['PROBES', probes],
  ]);
  const readOnlyMatcherRepo = Object.freeze({
    async getRecords(tab) { return cache.get(tab) || []; },
  });

  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const candidatePredicate = candidateMode === 'missing_identity' ? isMissingIdentity : isUnresolved;
  const candidates = communications
    .map((record) => record.obj)
    .filter((comm) => text(comm.direction).toLowerCase() === 'inbound')
    .filter((comm) => isRecent(comm, cutoff) && candidatePredicate(comm))
    .sort((a, b) => new Date(b.occurred_at || b.received_at) - new Date(a.occurred_at || a.received_at))
    .slice(0, limit);

  const evaluations = [];
  for (const comm of candidates) {
    const occurredAt = new Date(comm.occurred_at || comm.received_at);
    const matchAt = Number.isNaN(occurredAt.getTime()) ? now : occurredAt;
    const proposed = await matchInboundCommunication(readOnlyMatcherRepo, matcherInput(comm), matchAt);
    evaluations.push({ communication: comm, proposed, status: proposedStatus(proposed) });
  }
  return { evaluations, parameters: { days, limit }, agencies, probes };
}

export async function runInboundMatchDryRun(repo, { days = DEFAULT_DAYS, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const { evaluations, parameters, agencies, probes } = await evaluateInboundMatchCandidates(repo, { days, limit, now });
  const agencyIndex = byId(agencies, 'agency_id');
  const probeIndex = byId(probes, 'probe_id');

  const rows = evaluations.map(({ communication: comm, proposed, status }) => {
    const currentAgency = agencyIndex.get(text(comm.agency_id));
    const currentProbe = probeIndex.get(text(comm.probe_id));
    const proposedAgency = agencyIndex.get(text(proposed.agency_id));
    const proposedProbe = probeIndex.get(text(proposed.probe_id));
    return {
      communication_id: text(comm.communication_id),
      occurred_at: text(comm.occurred_at || comm.received_at),
      channel: text(comm.channel),
      source_identifier: text(comm.source_identifier_normalized || comm.source_identifier_raw),
      source_identifier_raw: text(comm.source_identifier_raw),
      display_name: text(comm.display_name),
      subject: text(comm.subject),
      body_text: text(comm.body_text),
      transcript: text(comm.transcript),
      content_preview: preview(comm),
      recording_available: Boolean(text(comm.recording_reference)),
      duration_seconds: text(comm.duration_seconds),
      voicemail_present: text(comm.voicemail_present),
      current_agency_id: text(comm.agency_id),
      current_agency_name: text(currentAgency?.agency_name || currentAgency?.clean_agency_name),
      current_probe_id: text(comm.probe_id),
      current_probe_property: text(currentProbe?.property_address || currentProbe?.property_street),
      proposed_agency_id: text(proposed.agency_id),
      proposed_agency_name: text(proposedAgency?.agency_name || proposedAgency?.clean_agency_name),
      proposed_probe_id: text(proposed.probe_id),
      proposed_probe_property: text(proposedProbe?.property_address || proposedProbe?.property_street),
      proposed_matching_method: text(proposed.matching_method),
      evidence_reason: evidenceReason(proposed),
      status,
    };
  });

  const summary = { reviewed: rows.length, recoverable: 0, unmatched: 0, ambiguous: 0, conflict: 0 };
  for (const row of rows) summary[row.status]++;

  const agency_options = agencies
    .map((record) => ({
      agency_id: text(record.obj.agency_id),
      agency_name: text(record.obj.agency_name || record.obj.clean_agency_name),
    }))
    .filter((row) => row.agency_id)
    .sort((a, b) => a.agency_name.localeCompare(b.agency_name));

  const probe_options = probes
    .map((record) => ({
      probe_id: text(record.obj.probe_id),
      agency_id: text(record.obj.agency_id),
      property_address: text(record.obj.property_address || record.obj.property_street),
      probe_reference: text(record.obj.probe_reference),
      probe_timestamp: text(record.obj.probe_timestamp),
      probe_status: text(record.obj.probe_status),
    }))
    .filter((row) => row.probe_id)
    .sort((a, b) => new Date(b.probe_timestamp || 0) - new Date(a.probe_timestamp || 0));

  return {
    read_only: true,
    generated_at: now.toISOString(),
    parameters,
    summary,
    rows,
    agency_options,
    probe_options,
  };
}
