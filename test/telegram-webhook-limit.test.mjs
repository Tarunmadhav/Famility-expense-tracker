// The "Connect the bot to this site" button moves where the shared bot posts, so
// it is capped per account. The cap must not become a way to read anything: the
// refusal names nothing and carries no token.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';

async function setup() {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  return { db, env };
}

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
    /* empty */
  }
  return { status: res.status, data, text };
}

async function account(env, email, name = 'Owner') {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/signup`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123', name }),
    }),
    env,
    { waitUntil() {} },
  );
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/ffp_session=[^;]+/) || [])[0];
  if (!cookie) throw new Error(`signup failed: ${res.status}`);
  const listed = await call(env, '/api/profiles', { cookie });
  return { cookie, books: (listed.data && listed.data.profiles) || [] };
}

test('the webhook button is rate-limited, and the refusal carries no secret', async () => {
  const { env } = await setup();
  const owner = await account(env, 'botbutton@example.com');

  // No bot token is configured here, so each early call fails at the Telegram
  // step; the counter still moves before that, which is the point of the test.
  for (let i = 0; i < 5; i += 1) {
    await call(env, '/api/telegram/webhook/register', { method: 'POST', cookie: owner.cookie, body: {} });
  }

  const sixth = await call(env, '/api/telegram/webhook/register', {
    method: 'POST',
    cookie: owner.cookie,
    body: {},
  });
  assert.equal(sixth.status, 429, `expected the sixth call to be refused, got ${sixth.status}`);
  assert.match(sixth.text, /Too many webhook registrations/);
  // Nothing from the environment may appear in a refusal.
  assert.ok(!/TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET/.test(sixth.text), 'a secret name leaked');
  assert.ok(!/\d{6,}:[\w-]{20,}/.test(sixth.text), 'a token-shaped value leaked');
});

test('a cross-origin press is still refused before the counter', async () => {
  const { env } = await setup();
  const owner = await account(env, 'botcors@example.com');
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/telegram/webhook/register`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        Cookie: owner.cookie,
      },
      body: '{}',
    }),
    env,
    { waitUntil() {} },
  );
  assert.equal(res.status, 403);
});
