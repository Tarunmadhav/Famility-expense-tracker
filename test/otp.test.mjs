// Email one-time codes: the code survives ten minutes at most, five wrong tries
// burn it, a used code cannot be replayed, and a new request replaces the old one.
// The provider call is stubbed (a fake HTTP transport, not a fake key) so this
// checks exactly what Resend would receive.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sendOtpEmail } from '../src/email.js';
import { applyMigrations } from '../src/migrations/runner.js';
import { consumeEmailOtp, createEmailOtp } from '../src/store.js';
import { makeDatabase } from './helpers/d1.mjs';

async function setup() {
  const { db, env } = makeDatabase();
  await applyMigrations(env);
  return { db, env };
}

test('a code works once and only for its email address', async () => {
  const { env } = await setup();
  const { code, minutes } = await createEmailOtp(env, 'Family@Example.com');
  assert.equal(minutes, 10);
  assert.match(code, /^\d{6}$/);

  // Case and spaces do not matter when the address is entered by hand.
  assert.equal(await consumeEmailOtp(env, ' family@example.com ', code), true);
  assert.equal(await consumeEmailOtp(env, 'family@example.com', code), false, 'a used code was accepted twice');
  assert.equal(await consumeEmailOtp(env, 'someone@example.com', code), false);
});

test('five wrong codes burn the row even if the real code arrives last', async () => {
  const { env } = await setup();
  const { code } = await createEmailOtp(env, 'tries@example.com');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await consumeEmailOtp(env, 'tries@example.com', '000000'), false);
  }
  assert.equal(await consumeEmailOtp(env, 'tries@example.com', code), false, 'the attempt ceiling did not hold');
});

test('an expired code is refused and removed', async () => {
  const { db, env } = await setup();
  const { code } = await createEmailOtp(env, 'late@example.com');
  db.prepare(`UPDATE email_otps SET expires_at = ? WHERE email = ?`).run(Date.now() - 1000, 'late@example.com');
  assert.equal(await consumeEmailOtp(env, 'late@example.com', code), false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_otps WHERE email = ?`).get('late@example.com').n, 0);
});

test('requesting a second code retires the first', async () => {
  const { env } = await setup();
  const first = await createEmailOtp(env, 'again@example.com');
  const second = await createEmailOtp(env, 'again@example.com');
  assert.equal(await consumeEmailOtp(env, 'again@example.com', first.code), false, 'the superseded code still worked');
  assert.equal(await consumeEmailOtp(env, 'again@example.com', second.code), true);
});

test('without a provider key the send fails loudly instead of pretending', async () => {
  await assert.rejects(
    () => sendOtpEmail({}, { to: 'a@example.com', code: '123456', minutes: 10 }),
    (err) => err.status === 501 && /RESEND_API_KEY/.test(err.message),
  );
});

test('a configured provider receives the code, the sender and the recipient', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  };
  try {
    const env = { RESEND_API_KEY: 'test-key', MAIL_FROM: 'Planner <code@example.com>' };
    assert.equal(await sendOtpEmail(env, { to: 'user@example.com', code: '432198', minutes: 10 }), true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
    assert.equal(body.from, 'Planner <code@example.com>');
    assert.deepEqual(body.to, ['user@example.com']);
    assert.match(body.subject, /432198/);
    assert.match(body.text, /432198/);
    assert.match(body.text, /expires in 10 minutes/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a rejected send is reported as a provider failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: 'domain is not verified', to: ['user@example.com'] }), { status: 403 });
  const quiet = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await assert.rejects(
      () => sendOtpEmail({ RESEND_API_KEY: 'test-key' }, { to: 'user@example.com', code: '1', minutes: 10 }),
      (err) => err.status === 502,
    );
    // Only the status is logged: the provider body echoes the recipient address.
    assert.ok(logged.join(' ').includes('403'));
    assert.ok(!logged.join(' ').includes('user@example.com'));
  } finally {
    globalThis.fetch = realFetch;
    console.error = quiet;
  }
});
