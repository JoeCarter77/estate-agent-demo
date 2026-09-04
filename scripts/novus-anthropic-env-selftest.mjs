#!/usr/bin/env node
// Hermetic tests for Anthropic environment routing and safe usage metadata.

import assert from 'node:assert/strict';
import {
  anthropicApiKeyVariable,
  getAnthropicApiKey,
  getAnthropicEnvironment,
} from '../lib/anthropic-server.mjs';
import { callAi, __setAiCallerForTests } from '../lib/ai-client.mjs';
import chatHandler from '../api/chat.js';

const ENV_NAMES = ['VERCEL_ENV', 'NOVUS_PRODUCTION_API', 'NOVUS_DEVELOPMENT_API', 'ANTHROPIC_API_KEY'];
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalLog = console.log;

const TOOL = {
  name: 'record_test',
  description: 'Record a test result.',
  input_schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};

function restore() {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  globalThis.fetch = originalFetch;
  console.log = originalLog;
}

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

try {
  assert.equal(getAnthropicEnvironment({ VERCEL_ENV: 'production' }), 'production');
  assert.equal(getAnthropicEnvironment({ VERCEL_ENV: 'preview' }), 'preview');
  assert.equal(getAnthropicEnvironment({}), 'local');
  assert.equal(anthropicApiKeyVariable({ VERCEL_ENV: 'production' }), 'NOVUS_PRODUCTION_API');
  assert.equal(anthropicApiKeyVariable({ VERCEL_ENV: 'preview' }), 'NOVUS_DEVELOPMENT_API');
  assert.equal(anthropicApiKeyVariable({}), 'NOVUS_DEVELOPMENT_API');

  assert.equal(getAnthropicApiKey({ env: { VERCEL_ENV: 'production', NOVUS_PRODUCTION_API: 'prod-test-key' }, loadLocalEnv: false }), 'prod-test-key');
  assert.equal(getAnthropicApiKey({ env: { VERCEL_ENV: 'preview', NOVUS_DEVELOPMENT_API: 'dev-test-key' }, loadLocalEnv: false }), 'dev-test-key');
  assert.equal(getAnthropicApiKey({ env: { NOVUS_DEVELOPMENT_API: 'dev-test-key' }, loadLocalEnv: false }), 'dev-test-key');
  assert.throws(
    () => getAnthropicApiKey({ env: { VERCEL_ENV: 'production', NOVUS_DEVELOPMENT_API: 'dev-test-key' }, loadLocalEnv: false }),
    /NOVUS_PRODUCTION_API is not configured/,
  );
  assert.throws(
    () => getAnthropicApiKey({ env: { NOVUS_PRODUCTION_API: 'prod-test-key' }, loadLocalEnv: false }),
    /NOVUS_DEVELOPMENT_API is not configured/,
  );
  assert.throws(
    () => getAnthropicApiKey({ env: { ANTHROPIC_API_KEY: 'legacy-test-key', NOVUS_DEVELOPMENT_API: 'dev-test-key' }, loadLocalEnv: false }),
    /ANTHROPIC_API_KEY is legacy/,
  );

  const requests = [];
  const logs = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'tool_use', name: TOOL.name, input: { value: 'ok' } }],
        usage: { input_tokens: 17, output_tokens: 9 },
        stop_reason: 'tool_use',
      }),
    };
  };
  console.log = (...args) => logs.push(args.join(' '));

  delete process.env.ANTHROPIC_API_KEY;
  process.env.NOVUS_PRODUCTION_API = 'prod-runtime-test-key';
  process.env.NOVUS_DEVELOPMENT_API = 'dev-runtime-test-key';

  for (const [vercelEnv, expectedKey, expectedEnvironment] of [
    ['production', 'prod-runtime-test-key', 'production'],
    ['preview', 'dev-runtime-test-key', 'preview'],
    [undefined, 'dev-runtime-test-key', 'local'],
  ]) {
    if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = vercelEnv;
    const result = await callAi({ system: 'test', prompt: 'test', tool: TOOL, purpose: 'env_selftest' });
    assert.deepEqual(result, { value: 'ok' });
    assert.equal(requests.at(-1).options.headers['x-api-key'], expectedKey);
    const usageLog = JSON.parse(logs.at(-1).replace(/^\[anthropic_usage\] /, ''));
    assert.equal(usageLog.environment, expectedEnvironment);
    assert.equal(usageLog.input_tokens, 17);
    assert.equal(usageLog.output_tokens, 9);
    assert.equal(usageLog.purpose, 'env_selftest');
    assert.equal(usageLog.success, true);
  }
  assert.ok(logs.every((line) => !line.includes('runtime-test-key')));

  process.env.VERCEL_ENV = 'preview';
  await callAi({
    system: 'test', prompt: 'test', tool: TOOL, purpose: 'owner_research_test',
    serverTools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });
  const webSearchLog = JSON.parse(logs.at(-1).replace(/^\[anthropic_usage\] /, ''));
  assert.equal(webSearchLog.server_tools_enabled, true);
  assert.equal(webSearchLog.web_search_enabled, true);

  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'rate limited' }, usage: { input_tokens: 3, output_tokens: 0 } }),
  });
  await assert.rejects(
    callAi({ system: 'test', prompt: 'test', tool: TOOL, purpose: 'failure_test' }),
    /rate limited/,
  );
  const failureLog = JSON.parse(logs.at(-1).replace(/^\[anthropic_usage\] /, ''));
  assert.equal(failureLog.success, false);
  assert.equal(failureLog.input_tokens, 3);
  assert.equal(failureLog.output_tokens, 0);
  assert.ok(logs.every((line) => !line.includes('runtime-test-key')));

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'test reply' }],
        usage: { input_tokens: 17, output_tokens: 9 },
      }),
    };
  };

  process.env.VERCEL_ENV = 'preview';
  const chatRes = fakeResponse();
  await chatHandler({ method: 'POST', body: { messages: [{ role: 'user', content: 'test' }] } }, chatRes);
  assert.equal(chatRes.statusCode, 200);
  assert.equal(requests.at(-1).options.headers['x-api-key'], 'dev-runtime-test-key');
  const chatUsageLog = JSON.parse(logs.at(-1).replace(/^\[anthropic_usage\] /, ''));
  assert.equal(chatUsageLog.environment, 'preview');
  assert.equal(chatUsageLog.purpose, 'legacy_demo_chat');
  assert.equal(chatUsageLog.input_tokens, 17);
  assert.ok(logs.every((line) => !line.includes('runtime-test-key')));

  // An injected caller remains fully offline and credential-independent.
  for (const name of ENV_NAMES) delete process.env[name];
  __setAiCallerForTests(async () => ({ value: 'fake' }));
  assert.deepEqual(await callAi({ system: 'test', prompt: 'test', tool: TOOL }), { value: 'fake' });

  originalLog('PASSED — Anthropic environment routing, safe usage logging, and fake-call isolation');
} finally {
  restore();
}
