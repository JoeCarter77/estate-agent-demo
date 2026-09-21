#!/usr/bin/env node
// scripts/novus-instantly-link.mjs — operator CLI for bringing an EXISTING
// Instantly campaign under NOVUS and reading the reconciliation back.
//
// Talks only to the DEPLOYED, Basic-Auth-protected NOVUS endpoints (the
// campaign operations on api/novus/personalisation.js). It never holds an
// Instantly key and never calls Instantly itself. Every write needs an
// explicit flag; the default for --campaign is a dry run.
//
//   node scripts/novus-instantly-link.mjs --discover
//   node scripts/novus-instantly-link.mjs --campaign <instantly_campaign_id>            # dry run (plan only)
//   node scripts/novus-instantly-link.mjs --campaign <instantly_campaign_id> --link     # link + import history
//   node scripts/novus-instantly-link.mjs --import --campaign-id <cmp_…> --activity a.csv --leads leads.csv [--confirm]
//   node scripts/novus-instantly-link.mjs --report --campaign-id <cmp_…>                # reconciliation table
//   node scripts/novus-instantly-link.mjs --sync [--campaign-id <cmp_…>]
//   node scripts/novus-instantly-link.mjs --audience                                    # new-campaign readiness (no write)
//
// Env: NOVUS_BASE_URL, NOVUS_BASIC_AUTH_USER, NOVUS_BASIC_AUTH_PASS (see .env).

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
  }
  return flags;
}
function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
}

async function main() {
  loadDotEnv();
  const flags = parseArgs(process.argv.slice(2));
  const base = String(flags.base || process.env.NOVUS_BASE_URL || '').replace(/\/+$/, '');
  const user = String(flags.user || process.env.NOVUS_BASIC_AUTH_USER || '');
  const pass = String(flags.pass || process.env.NOVUS_BASIC_AUTH_PASS || '');
  if (!base) throw new Error('Set --base or NOVUS_BASE_URL to the deployed NOVUS URL');
  if (!user || !pass) throw new Error('Set NOVUS_BASIC_AUTH_USER / NOVUS_BASIC_AUTH_PASS');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const op = (name) => `${base}/api/novus/personalisation?novus_operation=${name}`;
  const call = async (method, name, body, query = '') => {
    const res = await fetch(op(name) + query, { method, headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    if (!res.ok || data.success === false) throw new Error(`${name} → HTTP ${res.status}: ${data.error || data.raw || JSON.stringify(data).slice(0, 300)}`);
    return data;
  };
  const print = (obj) => console.log(JSON.stringify(obj, null, 2));

  if (flags.discover) {
    const data = await call('GET', 'campaign-discover');
    if (!data.available) throw new Error(`Instantly unavailable: ${JSON.stringify(data.error)}`);
    console.table(data.campaigns.map((c) => ({ name: c.name, instantly_campaign_id: c.instantly_campaign_id, instantly: c.status_label, created: c.timestamp_created.slice(0, 10), linked: c.linked ? `yes (${c.campaign_id})` : 'no' })));
    return;
  }
  if (flags.campaign) {
    const dryRun = !flags.link;
    const data = await call('POST', 'campaign-link', { instantly_campaign_id: String(flags.campaign), dry_run: dryRun, ...(dryRun ? {} : { confirm: 'LINK_INSTANTLY_CAMPAIGN' }), ...(flags.type ? { campaign_type: String(flags.type) } : {}) });
    const { review, config, ...rest } = data;
    print(rest);
    if (review?.length) { console.log(`\nNeeds review (${review.length}):`); console.table(review.map((r) => ({ email: r.email, status: r.match_status, method: r.match_method, note: r.match_note, candidates: (r.candidates || []).map((c) => c.agency_name || c.agency_id).join(' | ') }))); }
    if (dryRun) console.log('\nDRY RUN — nothing written. Re-run with --link to link and import history. Instantly is never modified.');
    return;
  }
  if (flags.import) {
    const campaignId = String(flags['campaign-id'] || '');
    if (!campaignId) throw new Error('--import needs --campaign-id <cmp_…>');
    const body = { campaign_id: campaignId, dry_run: !flags.confirm, ...(flags.confirm ? { confirm: 'IMPORT_CAMPAIGN_ACTIVITY' } : {}) };
    if (flags.activity) body.activity_csv = fs.readFileSync(String(flags.activity), 'utf8');
    if (flags.leads) body.leads_csv = fs.readFileSync(String(flags.leads), 'utf8');
    const data = await call('POST', 'campaign-import-activity', body);
    const { review, unknown_recipients: unknown, ...rest } = data;
    print(rest);
    if (unknown?.length) console.log(`\nRecipients in the activity export that are not members of this campaign (${unknown.length}):`, unknown.join(', '));
    if (review?.length) { console.log(`\nNeeds review (${review.length}):`); console.table(review.map((r) => ({ email: r.email, status: r.match_status, method: r.match_method, note: r.match_note }))); }
    if (!flags.confirm) console.log('\nDRY RUN — nothing written. Re-run with --confirm to import.');
    return;
  }
  if (flags.report) {
    const campaignId = String(flags['campaign-id'] || '');
    if (!campaignId) throw new Error('--report needs --campaign-id <cmp_…>');
    const data = await call('GET', 'campaign-reconciliation', null, `&campaign_id=${encodeURIComponent(campaignId)}`);
    print({ campaign: data.campaign, summary: data.summary });
    console.table(data.rows.map((r) => ({ agency: r.agency_name.slice(0, 28), email: r.email.slice(0, 34), match: `${r.match_status}${r.match_method ? '/' + r.match_method : ''}`.slice(0, 22), sent: r.emails_sent, steps: r.steps_sent.join(','), first: r.first_send_at.slice(0, 10), last: r.last_send_at.slice(0, 10), replies: r.replies, auto: r.auto_replies, pos: r.positive ? 'Y' : '', neg: r.negative ? 'Y' : '', bounce: r.bounced ? 'Y' : '', unsub: r.unsubscribed ? 'Y' : '', meet: r.meeting ? 'Y' : '', instantly: r.instantly_lead_status, interest: r.interest_status, novus: r.novus_stage })));
    if (flags.out) { fs.writeFileSync(String(flags.out), JSON.stringify(data, null, 2)); console.log(`\nFull report written to ${flags.out}`); }
    return;
  }
  if (flags.sync) {
    const data = await call('POST', 'campaign-sync', flags['campaign-id'] ? { campaign_id: String(flags['campaign-id']) } : {});
    print(data);
    return;
  }
  if (flags.audience) {
    // The "Enquiry → Quick Call V1" starting rules. Read-only: no draft is created.
    const filters = { probe_completed: true, probe_not_compromised: true, email_exists: true, verification: ['VALID'], never_emailed: true, include_opted_out: false, include_bounced: false, in_active_campaign: false };
    const policy = { cooling_days: Number(flags.cooling || 14), requires_probe: true, allow_risky_email: false, allow_generic_email: true, block_active_campaign: true, block_prior_negative: true, block_active_conversation: true, block_meeting_booked: true, block_active_followup: true };
    const strict = await call('POST', 'campaign-audience', { campaign_type: 'ENQUIRY_FOLLOWUP', filters, policy, limit: 1000 });
    // The same rules WITHOUT the never-emailed pre-filter, so previously
    // emailed / recently contacted leads are counted rather than hidden.
    const wide = await call('POST', 'campaign-audience', { campaign_type: 'ENQUIRY_FOLLOWUP', filters: { ...filters, never_emailed: null, include_opted_out: true, include_bounced: true, in_active_campaign: null, verification: ['VALID', 'RISKY', 'INVALID', 'UNKNOWN', 'ACCEPT_ALL', ''], email_exists: false, probe_completed: null, probe_not_compromised: false }, policy, limit: 1000 });
    print({
      generated_at: strict.generated_at, total_agencies: strict.total_agencies,
      enquiry_quick_call_v1: { selected_by_rules: strict.selected, eligible_agencies: strict.summary.READY, eligible_contacts: strict.buckets.selected.eligible_contacts, warning: strict.summary.WARNING, blocked: strict.summary.BLOCKED, reason_breakdown: strict.summary.reason_breakdown },
      whole_database: wide.buckets.all,
      unlinked_instantly_leads: wide.unlinked_members,
    });
    console.log('\nREADY agencies:'); console.table(strict.rows.filter((r) => r.eligibility.status === 'READY').map((r) => ({ agency: r.agency_name, contact: r.contact.name, email: r.contact.email, probe: r.probe?.reference, stage: r.stage })));
    if (flags.out) { fs.writeFileSync(String(flags.out), JSON.stringify({ strict, wide }, null, 2)); console.log(`\nFull audience written to ${flags.out}`); }
    return;
  }
  console.log('Usage: --discover | --campaign <id> [--link] | --import --campaign-id <cmp> --activity a.csv --leads l.csv [--confirm] | --report --campaign-id <cmp> | --sync | --audience');
}

main().catch((err) => { console.error(`\n✖ ${err.message}`); process.exit(1); });
