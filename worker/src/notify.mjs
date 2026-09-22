// worker/src/notify.mjs — actionable human-intervention notifications.
//
// Two channels, both local to the laptop the worker runs on:
//   1. a macOS Notification Centre banner (osascript), so it reaches you even
//      when NOVUS is not the front window;
//   2. the operator's own state, which the Prober panel polls — the durable
//      record, with the agency, the stage and what to actually do.
//
// A notification NEVER claims a probe was sent. The only place the word "sent"
// appears is when NOVUS itself has confirmed the transition, which is asserted
// by reading the PROBES row back (novus-client.isProbeRecordedAsSent) rather
// than by the button click.

import { execFile } from 'node:child_process';

export const INTERVENTIONS = {
  captcha: {
    title: 'CAPTCHA on Rightmove',
    action: 'Complete the challenge in the operator browser window, then press Release in NOVUS.',
  },
  login_required: {
    title: 'Rightmove sign-in expired',
    action: 'Sign back in to Rightmove in the operator browser window, then press Release in NOVUS.',
  },
  verification_challenge: {
    title: 'Human verification required',
    action: 'Clear the verification in the operator browser window, then press Release in NOVUS.',
  },
  agency_page_unavailable: {
    title: 'Agency page would not load',
    action: 'Open the branch URL yourself. Fix it in AGENCIES, or skip the agency manually.',
  },
  uncertain_suitability: {
    title: 'Property suitability unclear',
    action: 'Review the branch page and either pick a property manually or skip the agency.',
  },
  unexpected_form: {
    title: 'Enquiry form is not the approved one',
    action: 'Check the form in the operator browser window. Nothing was submitted.',
  },
  uncertain_submission: {
    title: 'Enquiry outcome UNCERTAIN — not confirmed sent',
    action: 'Check the probe mailbox for a Rightmove confirmation before doing anything. The operator will not resubmit.',
  },
  repeated_failure: {
    title: 'Repeated browser failures',
    action: 'Look at the operator browser window; the run is paused on this agency.',
  },
  probe_not_recorded: {
    title: 'NOVUS did not record the probe as sent',
    action: 'The enquiry went out but the PROBES row is not observing. Fix it in the Prober before resuming.',
  },
};

export function describeIntervention(reason, detail, current) {
  const known = INTERVENTIONS[reason] || { title: 'Operator needs you', action: 'Review the operator browser window.' };
  const agency = current?.agency_name || current?.agency_id || 'unknown agency';
  return {
    reason,
    title: known.title,
    agency,
    agency_id: current?.agency_id || '',
    stage: current?.stage || '',
    property_url: current?.property_url || '',
    submission_state: current?.submission?.state || 'none',
    action: known.action,
    detail: String(detail || ''),
  };
}

let lastBanner = '';

export function notifyDesktop({ title, body }) {
  if (process.platform !== 'darwin') { console.warn('[notify]', title, '—', body); return; }
  const key = `${title}::${body}`;
  if (key === lastBanner) return;            // never spam the same banner twice
  lastBanner = key;
  const escape = (value) => String(value).replace(/["\\]/g, '\\$&');
  const script = `display notification "${escape(body)}" with title "NOVUS operator" subtitle "${escape(title)}" sound name "Submarine"`;
  execFile('osascript', ['-e', script], (error) => {
    if (error) console.warn('[notify] banner failed:', error.message);
  });
}

export function notifyIntervention(intervention) {
  console.warn(`\n[HUMAN NEEDED] ${intervention.title}\n  agency : ${intervention.agency}\n  stage  : ${intervention.stage}\n  do     : ${intervention.action}\n  detail : ${intervention.detail}\n`);
  notifyDesktop({
    title: intervention.title,
    body: `${intervention.agency} — ${intervention.action}`,
  });
}
