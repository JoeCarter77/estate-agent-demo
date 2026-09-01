// Read-only production review over unresolved inbound COMMUNICATIONS.
//
// This module performs exactly three repository reads and hands the matcher a
// cached facade exposing only getRecords. It has no Sheets mutation method and
// cannot backfill communications.

import { matchInboundCommunication } from './inbound-matching.mjs';

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 100;
const MAX_DAYS = 90;
const MAX_LIMIT = 500;
const PREVIEW_LENGTH = 240;
const UNRESOLVED_METHODS = new Set(['', 'unmatched', 'ambiguous', 'conflict']);

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

function isUnresolved(comm) {
  const status = text(comm.match_status).toLowerCase();
  const method = text(comm.matching_method).toLowerCase();
  return !text(comm.probe_id)
    || !text(comm.agency_id)
    || status !== 'matched'
    || UNRESOLVED_METHODS.has(method);
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
  };
}

export function inboundMatchDryRunOptions(req) {
  return {
    days: boundedPositiveInteger(queryValue(req, 'days'), DEFAULT_DAYS, MAX_DAYS),
    limit: boundedPositiveInteger(queryValue(req, 'limit'), DEFAULT_LIMIT, MAX_LIMIT),
  };
}

export async function runInboundMatchDryRun(repo, { days = DEFAULT_DAYS, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const [communications, agencies, probes] = await Promise.all([
    repo.getRecords('COMMUNICATIONS', 'communication_id'),
    repo.getRecords('AGENCIES', 'agency_id'),
    repo.getRecords('PROBES', 'probe_id'),
  ]);
  const cache = new Map([['AGENCIES', agencies], ['PROBES', probes]]);
  const readOnlyMatcherRepo = Object.freeze({
    async getRecords(tab) { return cache.get(tab) || []; },
  });

  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const candidates = communications
    .map((record) => record.obj)
    .filter((comm) => text(comm.direction).toLowerCase() === 'inbound')
    .filter((comm) => isRecent(comm, cutoff) && isUnresolved(comm))
    .sort((a, b) => new Date(b.occurred_at || b.received_at) - new Date(a.occurred_at || a.received_at))
    .slice(0, limit);

  const rows = [];
  for (const comm of candidates) {
    const occurredAt = new Date(comm.occurred_at || comm.received_at);
    const matchAt = Number.isNaN(occurredAt.getTime()) ? now : occurredAt;
    const proposed = await matchInboundCommunication(readOnlyMatcherRepo, matcherInput(comm), matchAt);
    rows.push({
      communication_id: text(comm.communication_id),
      occurred_at: text(comm.occurred_at || comm.received_at),
      channel: text(comm.channel),
      source_identifier: text(comm.source_identifier_normalized || comm.source_identifier_raw),
      subject: text(comm.subject),
      content_preview: preview(comm),
      current_agency_id: text(comm.agency_id),
      current_probe_id: text(comm.probe_id),
      proposed_agency_id: text(proposed.agency_id),
      proposed_probe_id: text(proposed.probe_id),
      proposed_matching_method: text(proposed.matching_method),
      evidence_reason: evidenceReason(proposed),
      status: proposedStatus(proposed),
    });
  }

  const summary = { reviewed: rows.length, recoverable: 0, unmatched: 0, ambiguous: 0, conflict: 0 };
  for (const row of rows) summary[row.status]++;

  return {
    read_only: true,
    generated_at: now.toISOString(),
    parameters: { days, limit },
    summary,
    rows,
  };
}

