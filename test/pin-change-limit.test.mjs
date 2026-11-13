// Guessing the current PIN at "Change PIN" must cost the same as guessing it at
// the lock screen.
//
// The route used to verify the current PIN and answer 401 without recording a
// failure, so a stolen session could grind a 4-digit PIN with no limit. These
// tests drive the real route and read the real auth_fails table.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import { createUser, verifyUserPin } from '../src/store.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';

async function setup() {
  const { env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  return env;
}

const cookieOf = (res) => (String(res.headers.get('set-cookie') || '').match(/ffp_session=[^;]+/) || [])[0] || '';

async function login(env, pin) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    }),
    env,
    { waitUntil() {} },
  );
  return { status: res.status, cookie: cookieOf(res) };
}

async function changePin(env, cookie, body) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/pin`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {} },
  );
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* empty */
  }
  return { status: res.status, data };
}

const failures = (env) => env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_fails`).first().then((r) => r.n);

test('a wrong current PIN is counted, and eight of them lock the route', async () => {
  const env = await setup();
  await createUser(env, 'Owner', '1234');
  const signed = await login(env, '1234');
  assert.equal(signed.status, 200);

  for (let i = 0; i < 8; i += 1) {
    const out = await changePin(env, signed.cookie, { currentPin: '9999', newPin: '5678' });
    assert.equal(out.status, 401, `attempt ${i + 1} answered ${out.status}`);
  }
  assert.equal(await failures(env), 8, 'the wrong PINs were not recorded as failures');

  // Even the correct PIN is refused now: the point of a lockout is that the
  // window closes, not that the right guess is still allowed.
  const locked = await changePin(env, signed.cookie, { currentPin: '1234', newPin: '5678' });
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Too many attempts/);
});

test('a correct current PIN changes the PIN and clears the failures', async () => {
  const env = await setup();
  await createUser(env, 'Owner', '1234');
  const signed = await login(env, '1234');

  const once = await changePin(env, signed.cookie, { currentPin: '0000', newPin: '5678' });
  assert.equal(once.status, 401);
  assert.equal(await failures(env), 1);

  const ok = await changePin(env, signed.cookie, { currentPin: '1234', newPin: '5678' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(await verifyUserPin(env, (await env.DB.prepare(`SELECT id FROM users`).first()).id, '5678'), true);
  assert.equal(await failures(env), 0, 'a successful change left stale failures behind');
});

test('a malformed new PIN is refused before the current PIN is even checked', async () => {
  const env = await setup();
  await createUser(env, 'Owner', '1234');
  const signed = await login(env, '1234');
  const out = await changePin(env, signed.cookie, { currentPin: '1234', newPin: '12' });
  assert.equal(out.status, 400);
  assert.match(out.data.error, /4-12 digits/);
  assert.equal(await failures(env), 0);
});
