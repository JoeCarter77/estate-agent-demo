// worker/src/index.mjs — start the operator.
//
//   cd worker && npm start
//
// Prints the control token and the exact line to paste into the Autonomous
// Probing panel in NOVUS. Nothing is probed until Start is pressed there.

import { loadRepoEnv, loadConfig, assertConfig } from './config.mjs';
import { OperatorState, recoveryPlan } from './state.mjs';
import { OperatorBrowser } from './browser.mjs';
import { NovusClient } from './novus-client.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { createControlServer } from './control-server.mjs';
import { describeIntervention, notifyIntervention, prepareNotifications } from './notify.mjs';

loadRepoEnv();
const config = loadConfig();
assertConfig(config);

const state = new OperatorState(config.statePath);
const browser = new OperatorBrowser(config);
const novus = new NovusClient(config);
const orchestrator = new Orchestrator({ config, state, browser, novus });
prepareNotifications();

// A worker that starts on top of an unsettled transaction says so immediately,
// on the console and on the laptop, instead of waiting to be asked.
const plan = recoveryPlan(state.data.current);
if (plan.action === 'human') {
  state.data.current.needs_human = state.data.current.needs_human
    || { reason: plan.reason, detail: plan.detail || '', since: new Date().toISOString() };
  state.setRun({ mode: 'needs_human' });
  state.save();
  notifyIntervention(describeIntervention(plan.reason, plan.detail || plan.reason, state.data.current), {
    onClick: () => browser.focusInterventionTab(state.data.current),
  });
} else if (state.data.run.mode !== 'stopped') {
  state.setRun({ mode: 'stopped', stop_reason: 'worker restarted' });
}

const { server } = createControlServer({ config, state, orchestrator, browser });

server.listen(config.controlPort, config.controlHost, () => {
  const endpoint = `http://${config.controlHost}:${config.controlPort}`;
  console.log(`
NOVUS autonomous probe operator
  control endpoint : ${endpoint}
  control token    : ${config.controlToken}
  NOVUS            : ${config.novusBaseUrl}
  profile          : ${config.profileDir}
  state            : ${config.statePath}
  live submission  : ${config.liveSubmit ? 'ENABLED' : 'DISABLED (dry run — Send is never clicked)'}${config.allowedAgencyIds.length ? `\n  authorised only  : ${config.allowedAgencyIds.join(', ')}` : ''}
  recovery         : ${plan.action} — ${plan.reason}

Open ${config.novusBaseUrl}/novus/operator#prober, paste the token into the
Autonomous Probing panel, then press Start.
`);
});

async function shutdown(signal) {
  console.log(`\n[operator] ${signal} — shutting down. State is on disk; nothing will be resubmitted.`);
  try { await orchestrator.emergencyStop(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
