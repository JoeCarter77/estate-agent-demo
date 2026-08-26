// Hermetic NeverBounce helper tests. Run: npm run novus:neverbounce-selftest

import assert from 'node:assert/strict';
import { NeverBounceError, normalizeNeverBounceResult, verifyEmail } from '../lib/neverbounce.mjs';
import verifyHandler from '../api/novus/contacts/verify.js';

const originalApiKey = process.env.NEVERBOUNCE_API_KEY;
const originalAuthUser = process.env.NOVUS_BASIC_AUTH_USER;
const originalAuthPass = process.env.NOVUS_BASIC_AUTH_PASS;
const originalFetch = globalThis.fetch;

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
    setHeader() { return this; },
  };
}

process.env.NEVERBOUNCE_API_KEY = 'test-key';
process.env.NOVUS_BASIC_AUTH_USER = 'novus-test';
process.env.NOVUS_BASIC_AUTH_PASS = 'password-test';

try {
  assert.equal(normalizeNeverBounceResult('valid'), 'VALID');
  assert.equal(normalizeNeverBounceResult('invalid'), 'INVALID');
  assert.equal(normalizeNeverBounceResult('disposable'), 'INVALID');
  assert.equal(normalizeNeverBounceResult('catchall'), 'RISKY');
  assert.equal(normalizeNeverBounceResult('unknown'), 'UNKNOWN');
  assert.equal(normalizeNeverBounceResult('unexpected'), 'UNKNOWN');

  let requestedUrl;
  const result = await verifyEmail(' test+alias@example.com ', {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', result: 'catchall', flags: ['accepts_all'] }),
      };
    },
  });
  assert.equal(requestedUrl.origin, 'https://api.neverbounce.com');
  assert.equal(requestedUrl.pathname, '/v4.2/single/check');
  assert.equal(requestedUrl.searchParams.get('email'), 'test+alias@example.com');
  assert.equal(requestedUrl.searchParams.get('key'), 'test-key');
  assert.equal(result.verification_status, 'RISKY');
  assert.deepEqual(result.raw_result, { status: 'success', result: 'catchall', flags: ['accepts_all'] });

  await assert.rejects(
    () => verifyEmail('test@example.com', {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'error', message: 'No credits' }) }),
    }),
    (err) => err instanceof NeverBounceError && err.code === 'NEVERBOUNCE_API_ERROR' && err.statusCode === 503,
  );

  await assert.rejects(
    () => verifyEmail('test@example.com', {
      timeoutMs: 1,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }),
    (err) => err instanceof NeverBounceError && err.code === 'NEVERBOUNCE_TIMEOUT' && err.statusCode === 504,
  );

  process.env.NEVERBOUNCE_API_KEY = '';
  await assert.rejects(
    () => verifyEmail('test@example.com'),
    (err) => err instanceof NeverBounceError && err.code === 'MISSING_API_KEY' && err.statusCode === 500,
  );

  process.env.NEVERBOUNCE_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', result: 'valid', flags: ['has_dns_mx'] }),
  });
  const credentials = Buffer.from('novus-test:password-test').toString('base64');
  const response = mockResponse();
  await verifyHandler({
    method: 'POST',
    headers: { authorization: `Basic ${credentials}` },
    body: { email: 'person@example.com' },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    email: 'person@example.com',
    verification_status: 'VALID',
    raw_result: { status: 'success', result: 'valid', flags: ['has_dns_mx'] },
  });

  const missingEmailResponse = mockResponse();
  await verifyHandler({ method: 'POST', headers: { authorization: `Basic ${credentials}` }, body: {} }, missingEmailResponse);
  assert.equal(missingEmailResponse.statusCode, 400);
  assert.deepEqual(missingEmailResponse.body, { error: 'Missing email' });
} finally {
  if (originalApiKey === undefined) delete process.env.NEVERBOUNCE_API_KEY;
  else process.env.NEVERBOUNCE_API_KEY = originalApiKey;
  if (originalAuthUser === undefined) delete process.env.NOVUS_BASIC_AUTH_USER;
  else process.env.NOVUS_BASIC_AUTH_USER = originalAuthUser;
  if (originalAuthPass === undefined) delete process.env.NOVUS_BASIC_AUTH_PASS;
  else process.env.NOVUS_BASIC_AUTH_PASS = originalAuthPass;
  globalThis.fetch = originalFetch;
}

console.log('NOVUS NeverBounce self-test passed.');
