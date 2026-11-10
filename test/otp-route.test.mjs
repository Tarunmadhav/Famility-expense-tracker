// The OTP request form must not be usable to find out who has an account: a known
// address and an unknown one get the same status and the same body, configured or not.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';

async function call(env, path, { method = 'GET', body, cookie } = {}) {
  const headers = { Origin: ORIGIN };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
    { waitUntil() {} },
  );
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, data, text, cookie: res.headers.get('set-cookie') };
}

async function setup(extra = {}) {
  const { env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  Object.assign(env, extra);
  const signup = await call(env, '/api/auth/signup', {
    method: 'POST',
    body: { email: 'known@example.com', password: 'Password123', name: 'Known' },
  });
  assert.equal(signup.status, 200, JSON.stringify(signup.data));
  return env;
}

test('without a mail key both addresses get the same 501 and no send', async () => {
  const env = await setup();
  const known = await call(env, '/api/auth/otp/request', { method: 'POST', body: { email: 'known@example.com' } });
  const unknown = await call(env, '/api/auth/otp/request', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(known.status, 501);
  assert.equal(unknown.status, 501, 'an unknown address got a different answer');
  assert.equal(known.text, unknown.text, 'the replies differed, which reveals who has an account');
  assert.match(known.data.error, /RESEND_API_KEY/);
});

test('with a provider, both addresses get the same 200 and only the real one sends', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  };
  try {
    const env = await setup({ RESEND_API_KEY: 'test-key', MAIL_FROM: 'Planner <code@example.com>' });
    const known = await call(env, '/api/auth/otp/request', { method: 'POST', body: { email: 'known@example.com' } });
    const unknown = await call(env, '/api/auth/otp/request', { method: 'POST', body: { email: 'nobody@example.com' } });
    assert.equal(known.status, 200, JSON.stringify(known.data));
    assert.equal(unknown.status, 200, JSON.stringify(unknown.data));
    assert.deepEqual(known.data, unknown.data, 'the replies differed, which reveals who has an account');
    assert.equal(calls.length, 1, 'a code was emailed for an address with no account');
    assert.match(String(calls[0].init.body), /known@example\.com/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
