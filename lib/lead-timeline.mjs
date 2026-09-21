// lib/lead-timeline.mjs — PURE: one chronological story per agency, across
// every ledger NOVUS keeps. This is what the lead profile's History tab
// renders and what "full context when someone calls back" means in practice.
//
//   PROBES            enquiry sent, observation closed
//   COMMUNICATIONS    the agency's replies to the probe (email / call / sms)
//   OUTBOUND          handed to the legacy single Instantly campaign
//   CAMPAIGN_EVENTS   added to a campaign, emails sent/opened/clicked,
//                     replies, bounces, unsubscribes, interest changes
//   REPLY_EVENTS      classified sales replies
//   SALES_MESSAGES    manual replies / demo sends NOVUS made
//   DEMOS             demo viewed, CTA clicked, meeting booked
//   CALLS             every dial and its outcome
//   ACTIONS           completed follow-ups, and what is due next
//
// Every entry is { at, kind, type, title, detail, ...refs }. Nothing here
// touches a repo; the handler loads the tabs and calls buildLeadTimeline.

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const lower = (value) => text(value).toLowerCase();
const ts = (value) => { const n = Date.parse(text(value)); return Number.isFinite(n) ? n : null; };

export const TIMELINE_TABS = Object.freeze([
  'AGENCIES', 'CONTACTS', 'PROBES', 'COMMUNICATIONS', 'OUTBOUND', 'REPLY_EVENTS', 'SALES_MESSAGES', 'DEMOS', 'CALLS', 'ACTIONS',
  'CAMPAIGNS', 'CAMPAIGN_MEMBERS', 'CAMPAIGN_EVENTS',
]);

function records(table, idColumn) {
  const header = table?.header || [];
  const at = header.indexOf(idColumn);
  if (at < 0) return [];
  return (table.rows || []).flatMap((row) => {
    const id = text(row[at]);
    if (!id || id === 'SCHEMA NOTE') return [];
    return [Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))];
  });
}
function metadata(row) {
  try { return JSON.parse(text(row?.metadata_json) || '{}'); } catch { return {}; }
}

const CALL_OUTCOME = {
  NO_ANSWER: 'no answer', GATEKEPT: 'gatekept', OWNER_UNAVAILABLE: 'owner unavailable', CALLBACK_REQUESTED: 'callback requested',
  MORE_INFO_REQUESTED: 'more info requested', NOT_INTERESTED: 'not interested', BOOKED_MEETING: 'meeting booked', WRONG_NUMBER: 'wrong number',
  NOT_THE_DECISION_MAKER: 'not the decision-maker', DO_NOT_CALL: 'do not call', REFERRED_TO_EMAIL: 'referred to email',
};
const EVENT_TITLE = {
  CAMPAIGN_CREATED: 'Campaign created', LEAD_ADDED: 'Added to campaign', LEAD_PUSHED: 'Pushed to Instantly',
  LEAD_PUSH_FAILED: 'Push to Instantly failed', LEAD_SKIPPED: 'Skipped by Instantly', CAMPAIGN_PUSHED: 'Campaign pushed to Instantly',
  CAMPAIGN_LAUNCHED: 'Campaign launched', CAMPAIGN_PAUSED: 'Campaign paused', CAMPAIGN_RESUMED: 'Campaign resumed',
  EMAIL_SENT: 'Email sent', EMAIL_OPENED: 'Email opened', LINK_CLICKED: 'Link clicked', REPLY_RECEIVED: 'Reply received',
  AUTO_REPLY_RECEIVED: 'Auto-reply received', EMAIL_BOUNCED: 'Email bounced', LEAD_UNSUBSCRIBED: 'Unsubscribed',
  LEAD_INTERESTED: 'Marked interested', LEAD_NOT_INTERESTED: 'Marked not interested', LEAD_NEUTRAL: 'Marked neutral',
  LEAD_MEETING_BOOKED: 'Meeting booked (Instantly)', LEAD_MEETING_COMPLETED: 'Meeting completed (Instantly)',
  LEAD_CLOSED: 'Lead closed (Instantly)', LEAD_OUT_OF_OFFICE: 'Out of office', LEAD_WRONG_PERSON: 'Wrong person',
  LEAD_NO_SHOW: 'No show', CAMPAIGN_COMPLETED: 'Campaign completed', ACCOUNT_ERROR: 'Sending account error', OTHER: 'Instantly event',
  MANUAL_REPLY_SENT: 'Reply sent from the Instantly inbox', LEAD_IMPORTED: 'Found in Instantly campaign (linked)', CAMPAIGN_LINKED: 'Instantly campaign linked',
};
const EVENT_TONE = {
  EMAIL_SENT: 'blue', EMAIL_OPENED: 'blue', LINK_CLICKED: 'blue', REPLY_RECEIVED: 'green', LEAD_INTERESTED: 'green',
  LEAD_MEETING_BOOKED: 'green', LEAD_MEETING_COMPLETED: 'green', EMAIL_BOUNCED: 'red', LEAD_UNSUBSCRIBED: 'red',
  LEAD_NOT_INTERESTED: 'red', LEAD_WRONG_PERSON: 'amber', AUTO_REPLY_RECEIVED: 'grey', LEAD_OUT_OF_OFFICE: 'grey',
  MANUAL_REPLY_SENT: 'blue', LEAD_IMPORTED: 'grey',
};

export function buildLeadTimeline(tables, agencyId, { now = new Date().toISOString() } = {}) {
  const id = text(agencyId);
  const nowMs = Date.parse(now) || Date.now();
  const agency = records(tables.AGENCIES, 'agency_id').find((row) => text(row.agency_id) === id) || null;
  const contacts = records(tables.CONTACTS, 'contact_id').filter((row) => text(row.agency_id) === id);
  const emails = new Set([
    lower(agency?.outreach_contact_email), lower(agency?.primary_contact_email),
    ...contacts.map((row) => lower(row.email)),
  ].filter(Boolean));
  const campaignsById = new Map(records(tables.CAMPAIGNS, 'campaign_id').map((row) => [text(row.campaign_id), row]));
  const campaignName = (cid) => text(campaignsById.get(text(cid))?.name) || text(cid);
  const entries = [];
  const push = (entry) => { if (entry.at || entry.future) entries.push(entry); };

  for (const probe of records(tables.PROBES, 'probe_id').filter((row) => text(row.agency_id) === id)) {
    const property = text(probe.property_street || probe.property_address);
    push({ at: text(probe.probe_timestamp || probe.created_at), kind: 'probe', type: 'PROBE_SENT', tone: 'violet',
      title: `${text(probe.portal) ? text(probe.portal).replace(/^\w/, (c) => c.toUpperCase()) : 'Portal'} probe sent`, detail: [text(probe.probe_reference), property].filter(Boolean).join(' · '),
      probe_id: text(probe.probe_id) });
    if (text(probe.observation_closed_at)) {
      push({ at: text(probe.observation_closed_at), kind: 'probe', type: 'PROBE_CLOSED', tone: 'grey', title: 'Probe observation closed',
        detail: upper(probe.compromised) === 'TRUE' ? `compromised: ${text(probe.compromise_reason)}` : text(probe.probe_reference), probe_id: text(probe.probe_id) });
    }
  }
  for (const comm of records(tables.COMMUNICATIONS, 'communication_id').filter((row) => text(row.agency_id) === id)) {
    const channel = lower(comm.channel) || 'email';
    const inbound = lower(comm.direction) !== 'outbound';
    const human = lower(comm.automated_or_human);
    push({ at: text(comm.occurred_at || comm.received_at), kind: 'communication', type: `PROBE_${channel.toUpperCase()}_${inbound ? 'IN' : 'OUT'}`, tone: inbound ? 'violet' : 'grey',
      title: inbound ? `Agency replied to probe (${channel}${human ? `, ${human}` : ''})` : `Probe ${channel} sent`,
      detail: text(comm.subject) || text(comm.transcript || comm.body_text).slice(0, 140), communication_id: text(comm.communication_id) });
  }
  for (const out of records(tables.OUTBOUND, 'outbound_id').filter((row) => text(row.agency_id) === id)) {
    if (text(out.instantly_added_at)) {
      push({ at: text(out.instantly_added_at), kind: 'outbound', type: 'HANDED_TO_INSTANTLY', tone: 'blue', title: 'Handed to Instantly (legacy sequence)',
        detail: `${text(out.outreach_contact_email)} · ${text(out.property_street)}`, outbound_id: text(out.outbound_id) });
    }
  }
  const events = records(tables.CAMPAIGN_EVENTS, 'event_id').filter((row) => text(row.agency_id) === id || (emails.size && emails.has(lower(row.lead_email))));
  for (const ev of events) {
    const type = upper(ev.event_type);
    if (['CAMPAIGN_CREATED', 'CAMPAIGN_PUSHED', 'CAMPAIGN_LAUNCHED', 'CAMPAIGN_PAUSED', 'CAMPAIGN_RESUMED', 'CAMPAIGN_COMPLETED', 'ACCOUNT_ERROR'].includes(type) && !text(ev.agency_id)) continue;
    const step = text(ev.step) ? ` · email ${text(ev.step)}` : '';
    const detailParts = [campaignName(ev.campaign_id) + step];
    if (text(ev.subject)) detailParts.push(text(ev.subject));
    else if (text(ev.snippet)) detailParts.push(text(ev.snippet).slice(0, 140));
    if (type === 'LEAD_PUSH_FAILED' || type === 'LEAD_SKIPPED') detailParts.push(text(ev.snippet));
    if (type === 'LEAD_ADDED' && text(ev.snippet)) {
      // "READY: EMAIL_VALID,PROBE_COMPLETE" → "ready · email valid · probe complete"
      const [status, codes] = text(ev.snippet).split(':');
      detailParts.length = 1;
      detailParts[0] = `${campaignName(ev.campaign_id)} · ${lower(status)}${codes ? ` · ${codes.split(',').map((c) => lower(c).replace(/_/g, ' ')).join(' · ')}` : ''}`;
    }
    push({ at: text(ev.occurred_at || ev.received_at || ev.created_at), kind: 'campaign', type, tone: EVENT_TONE[type] || 'blue',
      title: EVENT_TITLE[type] || type, detail: detailParts.filter(Boolean).join(' · '), campaign_id: text(ev.campaign_id), event_id: text(ev.event_id), source: text(ev.source) });
  }
  const replyEmailIds = new Set(events.filter((row) => upper(row.event_type) === 'REPLY_RECEIVED').map((row) => text(row.instantly_email_id)).filter(Boolean));
  for (const reply of records(tables.REPLY_EVENTS, 'reply_event_id').filter((row) => text(row.agency_id) === id || (emails.size && emails.has(lower(row.lead_email))))) {
    // The same inbound mail may be both a webhook event and a classified
    // REPLY_EVENTS row; the classified row is the richer one, so it wins and
    // the webhook copy is dropped.
    const emailId = text(reply.instantly_email_id);
    if (emailId && replyEmailIds.has(emailId)) {
      const index = entries.findIndex((e) => e.kind === 'campaign' && e.type === 'REPLY_RECEIVED' && events.some((ev) => text(ev.event_id) === e.event_id && text(ev.instantly_email_id) === emailId));
      if (index >= 0) entries.splice(index, 1);
    }
    const cls = upper(reply.classification);
    push({ at: text(reply.received_at || reply.processed_at), kind: 'reply', type: 'REPLY_RECEIVED', tone: /POSITIVE/.test(cls) ? 'green' : /NOT_INTERESTED|OPT_OUT/.test(cls) ? 'red' : 'amber',
      title: `Reply received${cls ? ` — ${cls.replace(/_/g, ' ').toLowerCase()}` : ''}`,
      detail: text(reply.cleaned_reply_text || reply.body_text).slice(0, 160), reply_event_id: text(reply.reply_event_id), outbound_id: text(reply.outreach_id) });
  }
  for (const msg of records(tables.SALES_MESSAGES, 'sales_message_id').filter((row) => text(row.agency_id) === id)) {
    if (upper(msg.send_outcome) !== 'SENT') continue;
    const type = upper(msg.message_type);
    push({ at: text(msg.sent_at || msg.created_at), kind: 'sales', type: `SALES_${type || 'MESSAGE'}`, tone: 'blue',
      title: type === 'DEMO_REPLY' ? 'Demo sent (reply)' : type === 'FOLLOW_UP' ? 'Follow-up sent' : 'Manual reply sent',
      detail: text(msg.subject) || text(msg.body_text).slice(0, 140), sales_message_id: text(msg.sales_message_id) });
  }
  for (const demo of records(tables.DEMOS, 'demo_id').filter((row) => text(row.agency_id) === id)) {
    if (text(demo.first_viewed_at)) push({ at: text(demo.first_viewed_at), kind: 'demo', type: 'DEMO_VIEWED', tone: 'green', title: 'Demo viewed', detail: `${text(demo.demo_slug)}${Number(demo.view_count) > 1 ? ` · ${text(demo.view_count)} views` : ''}` });
    if (text(demo.cta_clicked_at)) push({ at: text(demo.cta_clicked_at), kind: 'demo', type: 'DEMO_CTA', tone: 'green', title: 'Demo CTA clicked', detail: text(demo.demo_slug) });
    if (text(demo.meeting_booked_at)) push({ at: text(demo.meeting_booked_at), kind: 'demo', type: 'MEETING_BOOKED', tone: 'green', title: 'Meeting booked', detail: text(demo.demo_slug) });
  }
  for (const call of records(tables.CALLS, 'call_id').filter((row) => text(row.agency_id) === id && upper(row.call_status) !== 'DISCARDED')) {
    const inbound = upper(metadata(call).direction) === 'INBOUND';
    const outcome = CALL_OUTCOME[upper(call.outcome)] || lower(call.outcome).replace(/_/g, ' ') || (text(call.connected_at) ? 'connected' : 'not logged');
    push({ at: text(call.started_at || call.created_at), kind: 'call', type: inbound ? 'CALL_INBOUND' : 'CALL_OUTBOUND', tone: /meeting|callback|more info/.test(outcome) ? 'green' : /not interested|do not call|wrong/.test(outcome) ? 'red' : 'grey',
      title: `${inbound ? 'Called back' : 'Called'} — ${outcome}`,
      detail: [text(call.contact_name), text(call.callback_note || call.meeting_note || call.useful_note).slice(0, 140)].filter(Boolean).join(' · '), call_id: text(call.call_id) });
  }
  for (const action of records(tables.ACTIONS, 'action_id').filter((row) => text(row.agency_id) === id)) {
    const status = upper(action.action_status);
    const label = text(action.action_type).replace(/_/g, ' ').toLowerCase();
    if (status === 'COMPLETED') {
      push({ at: text(action.completed_at || action.updated_at), kind: 'action', type: 'ACTION_COMPLETED', tone: 'grey', title: `Done: ${label}`, detail: text(action.completion_reason || action.reason).slice(0, 140), action_id: text(action.action_id) });
    } else if (['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'].includes(status)) {
      const due = ts(action.due_at);
      push({ at: text(action.due_at), future: true, overdue: due !== null && due < nowMs, kind: 'action', type: 'ACTION_DUE', tone: 'amber',
        title: `${label} ${due !== null && due < nowMs ? 'overdue' : 'due'}`, detail: text(action.reason).slice(0, 140), action_id: text(action.action_id) });
    }
  }

  entries.sort((a, b) => {
    const am = ts(a.at) ?? Infinity; const bm = ts(b.at) ?? Infinity;
    return am - bm || String(a.type).localeCompare(String(b.type));
  });
  const past = entries.filter((e) => !e.future);
  const future = entries.filter((e) => e.future);
  return {
    agency_id: id,
    agency_name: text(agency?.clean_agency_name || agency?.agency_name),
    generated_at: now,
    entries: [...past, ...future],
    counts: entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {}),
    campaigns: records(tables.CAMPAIGN_MEMBERS, 'member_id').filter((row) => text(row.agency_id) === id).map((row) => ({
      campaign_id: text(row.campaign_id), name: campaignName(row.campaign_id), status: upper(campaignsById.get(text(row.campaign_id))?.status),
      member_status: upper(row.member_status), instantly_lead_status: upper(row.instantly_lead_status), interest_status: upper(row.interest_status),
      emails_sent_count: Number(row.emails_sent_count) || 0, added_at: text(row.added_at), last_event_type: upper(row.last_event_type), last_event_at: text(row.last_event_at),
    })),
  };
}

export const _internal = { records, EVENT_TITLE, EVENT_TONE, CALL_OUTCOME };
