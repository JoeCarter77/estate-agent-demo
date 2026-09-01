// GET /api/novus/debug/inbound-match-dry-run?days=14&limit=100
//
// Production read-only review of unresolved inbound COMMUNICATIONS. Protected
// by the existing NOVUS Basic Auth middleware and requireAuth below. This file
// deliberately creates a matcher repository exposing ONLY getRecords; no
// Sheets write method is reachable from the review loop.

import { getRepo } from '../../../lib/sheets.mjs';
import { matchInboundCommunication } from '../../../lib/inbound-matching.mjs';
import { requireAuth } from '../_auth.mjs';

export const maxDuration = 60;

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

function evidenceSummary(match) {
  const signals = (match.evidence || []).map((item) => {
    const identities = item.probe_id
      ? `probe=${item.probe_id}`
      : item.agency_ids?.length ? `agencies=${item.agency_ids.join('|')}` : '';
    return [item.method || item.type, identities, item.detail].filter(Boolean).join(': ');
  });
  return { confidence: Number(match.match_score) || 0, signals };
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

export async function runInboundMatchDryRun(repo, { days = DEFAULT_DAYS, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  // One production read per tab. The matcher sees cached records through a
  // facade that has no append/update/batch/write capability.
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
      source_identifier_normalized: text(comm.source_identifier_normalized),
      subject: text(comm.subject),
      content_preview: preview(comm),
      current_agency_id: text(comm.agency_id),
      current_probe_id: text(comm.probe_id),
      proposed_agency_id: text(proposed.agency_id),
      proposed_probe_id: text(proposed.probe_id),
      proposed_matching_method: text(proposed.matching_method),
      evidence_summary: evidenceSummary(proposed),
      status: proposedStatus(proposed),
    });
  }

  const summary = { reviewed: rows.length, recoverable: 0, still_unmatched: 0, ambiguous: 0, conflict: 0 };
  for (const row of rows) {
    if (row.status === 'recoverable') summary.recoverable++;
    else if (row.status === 'ambiguous') summary.ambiguous++;
    else if (row.status === 'conflict') summary.conflict++;
    else summary.still_unmatched++;
  }

  return {
    read_only: true,
    generated_at: now.toISOString(),
    parameters: { days, limit },
    summary,
    rows,
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const days = boundedPositiveInteger(queryValue(req, 'days'), DEFAULT_DAYS, MAX_DAYS);
  const limit = boundedPositiveInteger(queryValue(req, 'limit'), DEFAULT_LIMIT, MAX_LIMIT);

  try {
    const result = await runInboundMatchDryRun(getRepo(), { days, limit });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    console.error('inbound match dry-run error:', err?.message || String(err));
    return res.status(500).json({ error: err?.message || 'Failed to run inbound match dry-run' });
  }
}

