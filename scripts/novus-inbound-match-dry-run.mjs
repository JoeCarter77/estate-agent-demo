#!/usr/bin/env node
// Read-only review of recent unmatched/ambiguous COMMUNICATIONS rows.
// This script never writes. It uses the communication's occurred_at for the
// window bounds; candidates must still have an active/observing probe status.
//
// Usage: node scripts/novus-inbound-match-dry-run.mjs [--days=14] [--limit=100]

import { getRepo } from '../lib/sheets.mjs';
import { matchInboundCommunication } from '../lib/inbound-matching.mjs';

function numericFlag(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const days = numericFlag('days', 14);
const limit = numericFlag('limit', 100);
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const repo = getRepo();
const communications = await repo.getRecords('COMMUNICATIONS', 'communication_id');
const review = communications
  .map((record) => record.obj)
  .filter((comm) => comm.direction === 'inbound' && comm.match_status !== 'matched')
  .filter((comm) => {
    const time = new Date(comm.occurred_at || comm.received_at).getTime();
    return Number.isFinite(time) && time >= cutoff;
  })
  .sort((a, b) => new Date(b.occurred_at || b.received_at) - new Date(a.occurred_at || a.received_at))
  .slice(0, limit);

for (const comm of review) {
  const at = new Date(comm.occurred_at || comm.received_at);
  const proposed = await matchInboundCommunication(repo, {
    channel: comm.channel,
    sender_email: comm.channel === 'email' ? comm.source_identifier_raw : '',
    sender_phone: ['sms', 'voice'].includes(comm.channel) ? comm.source_identifier_raw : '',
    display_name: comm.display_name,
    subject: comm.subject,
    body_text: comm.body_text,
    raw_content: comm.raw_content,
    transcript: comm.transcript,
  }, at);
  const status = proposed.matching_method === 'conflict'
    ? 'conflict'
    : proposed.match_status === 'ambiguous' ? 'ambiguous' : proposed.match_status;
  console.log(JSON.stringify({
    communication_id: comm.communication_id,
    current_agency_id: comm.agency_id || '', current_probe_id: comm.probe_id || '',
    proposed_agency_id: proposed.agency_id, proposed_probe_id: proposed.probe_id,
    proposed_matching_method: proposed.matching_method,
    evidence: proposed.evidence,
    status,
  }));
}

console.error(`Reviewed ${review.length} inbound communication(s); no rows were written.`);
