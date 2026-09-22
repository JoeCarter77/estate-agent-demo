// worker/test/harness.mjs — one operator wired to the mock world.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, createMockWorld, routeRightmoveToMock } from './mock/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { OperatorState } from '../src/state.mjs';
import { OperatorBrowser } from '../src/browser.mjs';
import { NovusClient } from '../src/novus-client.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { APPROVED_IDENTITY } from './mock/fixtures.mjs';

export async function buildHarness(fixture, { liveSubmit = true, quiet = true, statePath = null } = {}) {
  const world = createMockWorld(fixture);
  const mock = await startMockServer(world);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novus-operator-'));

  const config = loadConfig({
    NOVUS_BASE_URL: mock.origin,
    NOVUS_BASIC_AUTH_USER: '', NOVUS_BASIC_AUTH_PASS: '',
    NOVUS_OPERATOR_TOKEN: 'test-token',
    NOVUS_OPERATOR_PROFILE: path.join(tmp, 'profile'),
    NOVUS_OPERATOR_STATE: statePath || path.join(tmp, 'state.json'),
    NOVUS_OPERATOR_EVIDENCE: path.join(tmp, 'evidence'),
    NOVUS_OPERATOR_HEADLESS: '1',
    NOVUS_OPERATOR_CHANNEL: process.env.NOVUS_TEST_CHANNEL || 'chrome',
    NOVUS_OPERATOR_AI: '0',
    NOVUS_OPERATOR_LIVE_SUBMIT: liveSubmit ? '1' : '0',
    NOVUS_PROBE_FIRST_NAME: APPROVED_IDENTITY.firstName,
    NOVUS_PROBE_LAST_NAME: APPROVED_IDENTITY.lastName,
    NOVUS_PROBE_EMAIL: APPROVED_IDENTITY.email,
    NOVUS_PROBE_PHONE: APPROVED_IDENTITY.phone,
    NOVUS_PROBE_POSTCODE: APPROVED_IDENTITY.postcode,
    NOVUS_OPERATOR_NAV_TIMEOUT: '20000',
    NOVUS_OPERATOR_CTRL_TIMEOUT: '15000',
    NOVUS_OPERATOR_SUBMIT_TIMEOUT: '8000',
  });

  const state = new OperatorState(config.statePath);
  const browser = new OperatorBrowser(config);
  const novus = new NovusClient(config);
  const logs = [];
  const orchestrator = new Orchestrator({
    config, state, browser, novus,
    log: (...args) => { logs.push(args.join(' ')); if (!quiet) console.log(...args); },
  });

  await browser.launch();
  await routeRightmoveToMock(browser.context, mock.origin);

  return {
    world, mock, config, state, browser, novus, orchestrator, logs, tmp,
    async run({ batchSize = 1, dailyLimit = 50 } = {}) {
      const started = await orchestrator.start({ batchSize, dailyLimit, liveSubmit });
      if (orchestrator.loopPromise) await orchestrator.loopPromise;
      return started;
    },
    async close() {
      await browser.close().catch(() => {});
      await new Promise((resolve) => mock.server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
