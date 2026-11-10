// WhatsApp webhook wiring: the two routes Meta calls with no session.
//
// Nothing here needs a real Meta account — the app secret and verify token are the
// values a deployment is given — so this proves the handshake and the signature
// check work before any credential is bought. Graph API calls are stubbed.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
const SECRET = 'test-app-secret-not-real';
const VERIFY = 'test-verify-token-not-real';

async function setup(extra = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, extra);
  await applyMigrations(env);
  return { db, env };
}

async function webhook(env, { method = 'GET', path = '/api/whatsapp/webhook', body, headers = {} } = {}) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, body, headers }),
    env,
    { waitUntil() {} },
  );
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
}

function signed(body, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

test('the verify handshake refuses everything until a verify token is set', async () => {
  const { env } = await setup();
  const res = await webhook(env, { path: '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42' });
  assert.equal(res.status, 501);
  assert.match(res.text, /WHATSAPP_VERIFY_TOKEN/);
});

test('the verify handshake echoes the challenge only for the right token', async () => {
  const { env } = await setup({ WHATSAPP_VERIFY_TOKEN: VERIFY });
  const wrong = await webhook(env, {
    path: '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42',
  });
  assert.equal(wrong.status, 403);

  const right = await webhook(env, {
    path: `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`,
  });
  assert.equal(right.status, 200);
  assert.equal(right.text, '42');
});

test('an unsigned or badly signed delivery is rejected before parsing', async () => {
  const { env } = await setup({ WHATSAPP_APP_SECRET: SECRET });
  const body = JSON.stringify({ entry: [] });

  const unsigned = await webhook(env, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(unsigned.status, 401);

  const forged = await webhook(env, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signed(body, 'wrong-secret') },
  });
  assert.equal(forged.status, 401);
});

test('without an app secret the delivery is refused, not trusted', async () => {
  const { env } = await setup();
  const body = JSON.stringify({ entry: [] });
  const res = await webhook(env, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signed(body) },
  });
  assert.equal(res.status, 501);
  assert.match(res.text, /WHATSAPP_APP_SECRET/);
});

test('a correctly signed delivery is accepted and a retry is not applied twice', async () => {
  const { env, db } = await setup({ WHATSAPP_APP_SECRET: SECRET });
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: 'wamid.TEST-1',
                  from: '919876543210',
                  type: 'text',
                  text: { body: 'summary' },
                  timestamp: '1760000000',
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const body = JSON.stringify(payload);

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(String(url));
    return new Response('{}', { status: 200 });
  };
  try {
    const first = await webhook(env, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signed(body) },
    });
    assert.equal(first.status, 200);

    const again = await webhook(env, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signed(body) },
    });
    assert.equal(again.status, 200, 'a retry must still answer 200 so Meta stops resending');
  } finally {
    globalThis.fetch = realFetch;
  }

  // No WHATSAPP_TOKEN is set, so the planner owes a reply it cannot deliver: it must
  // not have called the Graph API at all.
  assert.equal(sent.length, 0, 'a reply was attempted without a token');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_seen`).get().n, 1, 'the delivery was stored twice');
});

test('the webhook routes are exempt from the session check but not from the signature', async () => {
  const { env } = await setup({ WHATSAPP_APP_SECRET: SECRET });
  // No cookie, no Origin: Meta sends neither.
  const res = await webhook(env, { method: 'POST', body: '{}', headers: {} });
  assert.equal(res.status, 401);
});
