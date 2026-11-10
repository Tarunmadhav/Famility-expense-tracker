// The WhatsApp/SMS number: what counts as valid, and what the app refuses to store.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { normaliseMobile } from '../src/phone.js';
import { SETTINGS } from '../src/seed.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';

async function call(env, path, { method = 'GET', body, cookie, profile } = {}) {
  const headers = { Origin: ORIGIN };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (profile) headers['X-Profile'] = profile;
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
  return { status: res.status, data, cookie: res.headers.get('set-cookie') };
}

async function signUp(env, email) {
  const res = await call(env, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'Password123', name: email.split('@')[0] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookie = String(res.cookie).match(/ffp_session=[^;]+/)[0];
  const account = await call(env, '/api/auth/account', { cookie });
  return { cookie, book: account.data.profiles[0].id };
}

test('the starter data no longer carries a phone number', () => {
  assert.equal(SETTINGS.mobile, '', 'seed data still pre-fills an alert number');
});

test('E.164 in, E.164 out — and no guessing at a missing country code', () => {
  assert.deepEqual(normaliseMobile(''), { ok: true, number: '' });
  assert.deepEqual(normaliseMobile('  +91 98765 43210 '), { ok: true, number: '+919876543210' });
  assert.deepEqual(normaliseMobile('+1 (415) 555-0142'), { ok: true, number: '+14155550142' });
  assert.equal(normaliseMobile('9876543210').ok, false, 'accepted a number with no country code');
  assert.equal(normaliseMobile('9876543210').reason, 'missing-country-code');
  assert.equal(normaliseMobile('+0123456789').ok, false, 'accepted a country code starting at 0');
  assert.equal(normaliseMobile('+91 12').ok, false, 'accepted too few digits');
  assert.equal(normaliseMobile('+1234567890123456').ok, false, 'accepted too many digits');
});

test('a new account starts with an empty number, and only its own number is saved', async () => {
  const { env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  const alice = await signUp(env, 'alice@example.com');
  const bob = await signUp(env, 'bob@example.com');

  const fresh = await call(env, '/api/state', { cookie: alice.cookie, profile: alice.book });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.settings.mobile, '', 'a new account showed a pre-filled number');

  const saved = await call(env, '/api/settings', {
    method: 'POST',
    cookie: alice.cookie,
    profile: alice.book,
    body: { mobile: ' +91 98765 43210 ', alertTime: '06:00', channel: 'Push' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.settings.mobile, '+919876543210');

  // The other account still sees nothing.
  const other = await call(env, '/api/state', { cookie: bob.cookie, profile: bob.book });
  assert.equal(other.data.settings.mobile, '');
});

test('an invalid number is rejected, not stored half-written', async () => {
  const { env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  const alice = await signUp(env, 'alice@example.com');

  for (const bad of ['9876543210', '+91 12', 'not a number', '+0123456789']) {
    const res = await call(env, '/api/settings', {
      method: 'POST',
      cookie: alice.cookie,
      profile: alice.book,
      body: { mobile: bad, alertTime: '06:00', channel: 'Push' },
    });
    assert.equal(res.status, 400, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.data.error, /country code|valid phone/, 'the error did not say what to fix');
  }

  const after = await call(env, '/api/state', { cookie: alice.cookie, profile: alice.book });
  assert.equal(after.data.settings.mobile, '', 'a rejected number was stored anyway');
});
