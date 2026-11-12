// A PIN change must land on the account that asked for it.
//
// The old route picked `ORDER BY created_at LIMIT 1`, so once a household had a
// second account, "Change PIN" reported success and rewrote the first account's
// row — the typed PIN still did not work. These tests drive the real route and
// read the real hashes back, so a regression cannot pass silently.

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

function cookieOf(res) {
  const header = res.headers.get('set-cookie') || '';
  return (header.match(/ffp_session=[^;]+/) || [])[0] || '';
}

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
  return worker.fetch(
    new Request(`${ORIGIN}/api/auth/pin`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {} },
  );
}

test("a PIN change rewrites the caller's own row, not the first account", async () => {
  const env = await setup();
  const first = await createUser(env, 'First', '1111');
  const second = await createUser(env, 'Second', '2222');

  const signedIn = await login(env, '2222');
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.cookie, 'the second account got a session');

  const res = await changePin(env, signedIn.cookie, { currentPin: '2222', newPin: '3333' });
  assert.equal(res.status, 200);

  assert.equal(await verifyUserPin(env, second.id, '3333'), true, 'the new PIN belongs to the caller');
  assert.equal(await verifyUserPin(env, second.id, '2222'), false, 'the old PIN no longer opens the account');
  assert.equal(await verifyUserPin(env, first.id, '1111'), true, 'the other account is untouched');
});

test('the current PIN must be the account’s own, never another member’s', async () => {
  const env = await setup();
  const first = await createUser(env, 'First', '1111');
  const second = await createUser(env, 'Second', '2222');

  const signedIn = await login(env, '2222');
  assert.ok(signedIn.cookie);

  // The first account's PIN is a valid secret in this deployment; it must still
  // not authorise a change on somebody else's session.
  const res = await changePin(env, signedIn.cookie, { currentPin: '1111', newPin: '9999' });
  assert.equal(res.status, 401);

  assert.equal(await verifyUserPin(env, first.id, '1111'), true);
  assert.equal(await verifyUserPin(env, second.id, '2222'), true);
  assert.equal(await verifyUserPin(env, second.id, '9999'), false);
});

async function get(env, path, cookie) {
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: { Origin: ORIGIN, Cookie: cookie } }),
    env,
    { waitUntil() {} },
  );
}

test('a PIN change signs out every other device and keeps this one', async () => {
  const env = await setup();
  await createUser(env, 'Owner', '1111');
  const here = await login(env, '1111');
  const elsewhere = await login(env, '1111');
  assert.ok(here.cookie && elsewhere.cookie);
  assert.notEqual(here.cookie, elsewhere.cookie, 'two sign-ins shared a session');

  const changed = await changePin(env, here.cookie, { currentPin: '1111', newPin: '4321' });
  assert.equal(changed.status, 200);

  const kept = await get(env, '/api/auth/account', here.cookie);
  assert.equal(kept.status, 200, 'the session that changed the PIN was signed out too');
  const revoked = await get(env, '/api/auth/account', elsewhere.cookie);
  assert.equal(revoked.status, 401, 'another device kept its session after a PIN change');
});

test('a PIN must still be 4-12 digits', async () => {
  const env = await setup();
  await createUser(env, 'First', '1111');
  const signedIn = await login(env, '1111');
  assert.ok(signedIn.cookie);

  const tooShort = await changePin(env, signedIn.cookie, { currentPin: '1111', newPin: '12' });
  assert.equal(tooShort.status, 400);
});
