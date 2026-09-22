import { replyPhoneNumbers } from './reply-call-context.mjs';

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const rows = (table, id) => {
  const header = table?.header || [];
  if (!header.includes(id)) return [];
  return (table.rows || []).filter((row) => text(row[header.indexOf(id)]) && text(row[header.indexOf(id)]) !== 'SCHEMA NOTE')
    .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ''])));
};

export function probeCallMetrics(campaign, members, events, tables = {}) {
  const campaignId = text(campaign?.instantly_campaign_id);
  const replies = rows(tables.REPLY_EVENTS, 'reply_event_id').filter((row) => text(row.campaign_id) === campaignId && text(row.agency_id));
  const actions = rows(tables.ACTIONS, 'action_id').filter((row) => {
    try { return text(JSON.parse(text(row.metadata_json) || '{}').campaign_id) === campaignId && text(row.action_type) === 'CALL_PROSPECT'; }
    catch { return false; }
  });
  const actionIds = new Set(actions.map((row) => text(row.action_id)));
  const calls = rows(tables.CALLS, 'call_id').filter((row) => actionIds.has(text(row.source_action_id)) && upper(row.call_status) !== 'DISCARDED');
  const bookedAgencies = new Set(calls.filter((row) => upper(row.outcome) === 'BOOKED_MEETING').map((row) => text(row.agency_id)));
  for (const member of members || []) if (text(member.meeting_booked_at) || ['MEETING_BOOKED', 'MEETING_COMPLETED', 'WON'].includes(upper(member.interest_status))) bookedAgencies.add(text(member.agency_id));
  const sessions = rows(tables.DISCOVERY_SESSIONS, 'session_id').filter((row) => bookedAgencies.has(text(row.agency_id)));
  const unique = (items, key) => new Set(items.map((row) => text(row[key])).filter(Boolean)).size;
  const analytics = (() => { try { return JSON.parse(text(campaign?.analytics_json) || '{}'); } catch { return {}; } })();
  const delivered = analytics.delivered_count ?? analytics.emails_delivered_count ?? null;
  const providerSends = Number(analytics.emails_sent_count);
  const ledgerSends = (events || []).filter((row) => upper(row.event_type) === 'EMAIL_SENT').length;
  return {
    actual_emails_sent: Math.max(ledgerSends, Number.isFinite(providerSends) ? providerSends : 0),
    delivered_emails: delivered === null ? null : Number(delivered) || 0,
    interested_replies: unique(replies.filter((row) => ['CALL_REQUESTED', 'POSITIVE_MEETING', 'POSITIVE_SEND_DEMO'].includes(upper(row.classification))), 'reply_event_id'),
    explicit_phone_replies: unique(replies.filter((row) => replyPhoneNumbers(row.body_text || row.cleaned_reply_text).length === 1), 'reply_event_id'),
    critical_call_actions: unique(actions, 'action_id'),
    critical_calls_attempted: unique(calls.filter((row) => text(row.outcome)), 'call_id'),
    owners_reached: unique(calls.filter((row) => upper(row.owner_reached) === 'TRUE' || text(row.owner_reached_at)), 'call_id'),
    meetings_booked: bookedAgencies.size,
    meetings_attended: unique(sessions.filter((row) => upper(row.status) === 'COMPLETED'), 'agency_id'),
    pilots_agreed: unique(sessions.filter((row) => upper(row.outcome) === 'PILOT_AGREED'), 'agency_id'),
    // A discovery agreement is not evidence of a sale. No durable pilot-sale
    // status exists in NOVUS yet, so expose the gap instead of reporting zero.
    pilots_sold: null,
  };
}
