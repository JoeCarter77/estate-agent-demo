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

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    action: 'If Rightmove showed its confirmation page, press "I saw Rightmove\u2019s confirmation" in NOVUS and the probe is recorded. Otherwise check the probe mailbox first. Either way the operator will not resubmit.',
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

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'macos-notifier.swift');
const app = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.state', 'NOVUS Operator.app');
const executable = path.join(app, 'Contents', 'MacOS', 'NOVUS Operator');
const children = new Set();
process.on('exit', () => { for (const child of children) child.kill(); });

function notifierExecutable() {
  if (fs.existsSync(executable) && fs.statSync(executable).mtimeMs >= fs.statSync(source).mtimeMs) return executable;
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>uk.co.novus.operator-notifier</string>
<key>CFBundleName</key><string>NOVUS Operator</string>
<key>CFBundleExecutable</key><string>NOVUS Operator</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`);
  const built = `${executable}.new`;
  const moduleCache = path.join(app, 'Contents', 'ModuleCache');
  fs.mkdirSync(moduleCache, { recursive: true });
  execFileSync('swiftc', ['-module-cache-path', moduleCache, source, '-o', built], { stdio: 'pipe', timeout: 120000 });
  fs.renameSync(built, executable);
  return executable;
}

export function prepareNotifications() {
  if (process.platform !== 'darwin') return;
  try { notifierExecutable(); }
  catch (error) { console.warn('[notify] macOS notifier is unavailable:', error.message); }
}

export function notifyDesktop({ title, body, onClick }) {
  if (process.platform !== 'darwin') { console.warn('[notify]', title, '—', body); return; }
  try {
    const child = spawn(notifierExecutable(), [String(title), String(body)], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('CLICK')) {
        output = '';
        Promise.resolve(onClick?.()).catch((error) => console.warn('[notify] could not focus Chrome:', error.message));
      }
    });
    child.stderr.on('data', (chunk) => console.warn('[notify]', chunk.toString().trim()));
    child.on('exit', (code) => { children.delete(child); if (code && code !== 0) console.warn('[notify] native notification exited:', code); });
    child.on('error', (error) => console.warn('[notify] native notification failed:', error.message));
  } catch (error) {
    console.warn('[notify] native notification could not start:', error.message);
  }
}

export function notifyIntervention(intervention, { onClick } = {}) {
  console.warn(`\n[HUMAN NEEDED] ${intervention.title}\n  agency : ${intervention.agency}\n  stage  : ${intervention.stage}\n  do     : ${intervention.action}\n  detail : ${intervention.detail}\n`);
  notifyDesktop({
    title: intervention.title,
    body: `${intervention.agency} — ${intervention.action}`,
    onClick,
  });
}
