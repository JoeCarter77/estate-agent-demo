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
  // Lead profile (buildLeadProfile): probe assessment, meetings, objections, script names.
  'INTELLIGENCE', 'DISCOVERY_SESSIONS', 'CALL_OBJECTION_EVENTS', 'SCRIPTS',
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
    if (metadata(action).source === 'EMAIL_REPLY') {
      push({ at: text(action.created_at), kind: 'action', type: 'CALL_REQUESTED_ACTION_CREATED', tone: 'green',
        title: 'Calling action created', detail: text(action.reason).slice(0, 140), action_id: text(action.action_id), reply_event_id: text(action.reply_event_id) });
    }
    if (status === 'COMPLETED') {
      push({ at: text(action.completed_at || action.updated_at), kind: 'action', type: 'ACTION_COMPLETED', tone: 'grey', title: `Done: ${label}`, detail: text(action.completion_reason || action.reason).slice(0, 140), action_id: text(action.action_id) });
    } else if (['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'].includes(status)) {
      const due = ts(action.due_at);
      push({ at: text(action.due_at), future: true, overdue: due !== null && due < nowMs, kind: 'action', type: 'ACTION_DUE', tone: 'amber',
        title: `${label} ${due !== null && due < nowMs ? 'overdue' : 'due'}`, detail: text(action.reason).slice(0, 140), action_id: text(action.action_id) });
    }
  }

  for (const session of records(tables.DISCOVERY_SESSIONS, 'session_id').filter((row) => text(row.agency_id) === id)) {
    const sid = text(session.session_id);
    if (text(session.meeting_at)) push({ at: text(session.meeting_at), future: (ts(session.meeting_at) ?? 0) > nowMs, kind: 'meeting', type: 'MEETING', tone: 'green', title: `Meeting${text(session.contact_name) ? ` with ${text(session.contact_name)}` : ''}`, detail: lower(session.status).replace(/_/g, ' '), session_id: sid });
    if (text(session.completed_at)) push({ at: text(session.completed_at), kind: 'meeting', type: 'DISCOVERY_COMPLETED', tone: 'green', title: `Discovery completed${text(session.outcome) ? ` — ${lower(session.outcome).replace(/_/g, ' ')}` : ''}`, detail: text(session.outcome_notes).slice(0, 160), session_id: sid });
    if (text(session.follow_up_at)) {
      const due = ts(session.follow_up_at);
      push({ at: text(session.follow_up_at), future: due === null || due >= nowMs, overdue: false, kind: 'meeting', type: 'MEETING_FOLLOW_UP', tone: 'amber', title: 'Meeting follow-up', detail: '', session_id: sid });
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

// ── THE LEAD PROFILE ──────────────────────────────────────────────────────
// Everything NOVUS holds about one agency, from the same tables the timeline
// reads, as facts only: a field that has no stored value is simply absent,
// and nothing is inferred or back-filled. Pure.
const OPEN = ['PENDING', 'DUE', 'IN_PROGRESS', 'SNOOZED'];
function json(value, fallback) { try { return JSON.parse(text(value)) ?? fallback; } catch { return fallback; } }
function pick(row, keys) {
  return Object.fromEntries(keys.map((k) => [k, text(row?.[k])]).filter(([, v]) => v));
}

export function buildLeadProfile(tables, agencyId, { now = new Date().toISOString() } = {}) {
  const id = text(agencyId);
  const nowMs = Date.parse(now) || Date.now();
  const mine = (tab, idCol) => records(tables[tab], idCol).filter((row) => text(row.agency_id) === id);
  const agency = records(tables.AGENCIES, 'agency_id').find((row) => text(row.agency_id) === id) || null;
  if (!agency) return null;

  const contacts = mine('CONTACTS', 'contact_id').map((c) => pick(c, ['contact_id', 'contact_name', 'contact_role', 'email', 'phone', 'mobile', 'verification_status', 'contact_type', 'phone_verification_status', 'source', 'created_at']));
  const replies = mine('REPLY_EVENTS', 'reply_event_id');
  const calls = mine('CALLS', 'call_id').filter((row) => upper(row.call_status) !== 'DISCARDED')
    .sort((a, b) => (ts(b.started_at) ?? 0) - (ts(a.started_at) ?? 0));
  const scripts = new Map(records(tables.SCRIPTS, 'script_id').map((row) => [text(row.script_id), row]));
  const intelligence = mine('INTELLIGENCE', 'intelligence_id');
  const sessions = mine('DISCOVERY_SESSIONS', 'session_id').sort((a, b) => (ts(b.meeting_at || b.created_at) ?? 0) - (ts(a.meeting_at || a.created_at) ?? 0));
  const actions = mine('ACTIONS', 'action_id');
  const campaignEvents = mine('CAMPAIGN_EVENTS', 'event_id');
  const sales = mine('SALES_MESSAGES', 'sales_message_id');

  const optedOut = replies.some((r) => upper(r.suppression_type) === 'PERMANENT' || upper(r.classification) === 'OPT_OUT')
    || campaignEvents.some((e) => upper(e.event_type) === 'LEAD_UNSUBSCRIBED');
  const doNotCall = calls.some((c) => upper(c.outcome) === 'DO_NOT_CALL');

  const open = actions.filter((a) => OPEN.includes(upper(a.action_status))).map((a) => {
    const meta = metadata(a);
    const due = ts(a.due_at);
    return { action_id: text(a.action_id), type: text(a.action_type), status: upper(a.action_status), owner: text(a.action_owner), due_at: text(a.due_at),
      overdue: due !== null && due < nowMs, reason: text(a.reason), priority: text(meta.priority), interested: meta.interested === true };
  }).sort((a, b) => (ts(a.due_at) ?? Infinity) - (ts(b.due_at) ?? Infinity));
  const completed = actions.filter((a) => upper(a.action_status) === 'COMPLETED')
    .sort((a, b) => (ts(b.completed_at || b.updated_at) ?? 0) - (ts(a.completed_at || a.updated_at) ?? 0));

  const objections = mine('CALL_OBJECTION_EVENTS', 'event_id').map((e) => text(e.objection_title)).filter(Boolean);
  const nextSteps = [
    ...open.filter((a) => a.due_at).map((a) => ({ at: a.due_at, what: a.type.replace(/_/g, ' ').toLowerCase() })),
    ...sessions.filter((s) => (ts(s.follow_up_at) ?? 0) >= nowMs).map((s) => ({ at: text(s.follow_up_at), what: 'meeting follow-up' })),
  ].sort((a, b) => (ts(a.at) ?? Infinity) - (ts(b.at) ?? Infinity));

  return {
    identity: {
      ...pick(agency, ['agency_id', 'location', 'branch_count', 'website', 'domain', 'rightmove_sales_branch_url', 'main_phone', 'known_phone_numbers', 'crm_name',
        'owner_md', 'live_listing_count', 'current_pipeline_status', 'suppression_status', 'contact_resolution_status', 'email_verification_status', 'source', 'created_at']),
      agency_name: text(agency.clean_agency_name || agency.agency_name),
      outreach_contact: pick(agency, ['outreach_contact_name', 'outreach_contact_email']),
      primary_contact: pick(agency, ['primary_contact_name', 'primary_contact_email']),
      other_known_emails: text(agency.other_known_emails),
    },
    contacts,
    suppression: { email_opted_out: optedOut, do_not_call: doNotCall, agency_suppression: text(agency.suppression_status) },
    probes: mine('PROBES', 'probe_id').map((p) => {
      const intel = intelligence.find((row) => text(row.probe_id) === text(p.probe_id)) || {};
      return { ...pick(p, ['probe_id', 'probe_reference', 'portal', 'property_street', 'property_address', 'probe_status', 'probe_timestamp', 'observation_closed_at', 'compromised', 'compromise_reason', 'enquiry_text']),
        assessment: pick(intel, ['human_contact', 'response_hours', 'first_human_response_at', 'contact_attempts', 'follow_ups', 'channels_used', 'seller_recognition', 'grade', 'grade_reason']) };
    }).sort((a, b) => (ts(b.probe_timestamp) ?? 0) - (ts(a.probe_timestamp) ?? 0)),
    email: {
      emails_sent: campaignEvents.filter((e) => upper(e.event_type) === 'EMAIL_SENT').length,
      replies_received: replies.length,
      manual_replies_sent: sales.filter((m) => upper(m.send_outcome) === 'SENT').length,
      latest_reply: replies.length ? pick([...replies].sort((a, b) => (ts(b.received_at) ?? 0) - (ts(a.received_at) ?? 0))[0], ['received_at', 'classification', 'cleaned_reply_text', 'lead_email']) : null,
    },
    calls: {
      attempts: calls.length,
      connected: calls.filter((c) => text(c.connected_at) || upper(c.connected) === 'TRUE').length,
      gatekeeper_conversations: calls.filter((c) => upper(c.gatekeeper_reached) === 'TRUE').length,
      owner_conversations: calls.filter((c) => upper(c.owner_reached) === 'TRUE' || text(c.owner_reached_at)).length,
      recent: calls.slice(0, 8).map((c) => ({ ...pick(c, ['call_id', 'started_at', 'outcome', 'contact_name', 'duration_seconds', 'callback_at']),
        note: text(c.useful_note || c.callback_note || c.more_info_note || c.meeting_note),
        script: scripts.get(text(c.script_id)) ? `${text(scripts.get(text(c.script_id)).name)} v${text(scripts.get(text(c.script_id)).version)}` : '',
        inbound: upper(metadata(c).direction) === 'INBOUND', owner_reached: upper(c.owner_reached) === 'TRUE' || Boolean(text(c.owner_reached_at)),
        gatekeeper_reached: upper(c.gatekeeper_reached) === 'TRUE' })),
      objections: [...new Set(objections)],
    },
    work: { open, completed_count: completed.length, recent_completed: completed.slice(0, 5).map((a) => pick(a, ['action_id', 'action_type', 'completed_at', 'completion_reason'])) },
    meetings: sessions.map((row) => {
      const agreement = json(row.conclusion_json, {})?.agreement || {};
      return { ...pick(row, ['session_id', 'meeting_at', 'contact_name', 'status', 'stage', 'outcome', 'outcome_notes', 'follow_up_at', 'completed_at', 'pitch_count']),
        findings_agreed: Object.values(agreement).filter((v) => upper(v?.status) === 'AGREED').length,
        findings_corrected: Object.values(agreement).filter((v) => upper(v?.status) === 'CORRECTED').length,
        agreed_scope: Boolean(text(row.agreed_scope_json) && text(row.agreed_scope_json) !== '{}') };
    }),
    next_step: nextSteps[0] || null,
  };
}

export const _internal = { records, EVENT_TITLE, EVENT_TONE, CALL_OUTCOME };
