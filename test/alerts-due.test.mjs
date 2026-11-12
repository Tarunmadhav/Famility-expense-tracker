// GET /api/alerts/due is what the phone's closed-app alarm asks for, so the
// properties that matter are: it needs a session, it only answers for books the
// caller may read, and it never carries an amount.

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

const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

test('an unauthenticated check is refused', async () => {
  const { env } = await setup();
  const res = await call(env, '/api/alerts/due');
  assert.equal(res.status, 401);
  assert.ok(!('items' in (res.data || {})), 'a refused request returned a deadline list');
});

test('a due task comes back for its own book only, with no amount', async () => {
  const { env } = await setup();
  const alice = await account(env, 'alice@example.com', 'Alice');
  const bob = await account(env, 'bob@example.com', 'Bob');
  const aliceFamily = alice.books.find((b) => b.kind === 'family');
  const bobFamily = bob.books.find((b) => b.kind === 'family');

  const created = await call(env, '/api/records', {
    method: 'POST',
    cookie: alice.cookie,
    profile: aliceFamily.id,
    body: {
      collection: 'diary',
      doc: {
        title: 'Renew the policy',
        dueAt: minutes(5),
        status: 'Pending',
        // A number the notification must never carry.
        amount: 4321,
      },
    },
  });
  assert.equal(created.status, 200, created.text);

  const aliceSees = await call(env, '/api/alerts/due', { cookie: alice.cookie });
  assert.equal(aliceSees.status, 200);
  assert.equal(aliceSees.data.items.length, 1, 'the due task was not listed');
  const item = aliceSees.data.items[0];
  assert.equal(typeof item.id, 'string');
  assert.ok(item.id.length > 0, 'the item has no stable id');
  assert.equal(typeof item.title, 'string');
  assert.ok(Number(item.dueAt) > Date.now(), 'the due moment is not in the future');
  assert.ok(!JSON.stringify(item).includes('4321'), 'an amount leaked into the alert');
  assert.ok(!JSON.stringify(item).includes('Renew the policy'), 'the task title leaked into the alert');

  // Bob has no task, and can never see Alice's.
  const bobSees = await call(env, '/api/alerts/due', { cookie: bob.cookie });
  assert.equal(bobSees.status, 200);
  assert.deepEqual(bobSees.data.items, []);
  assert.equal(bobFamily.id === aliceFamily.id, false);
});

test('a completed or distant task is not announced, and the id is stable', async () => {
  const { env } = await setup();
  const owner = await account(env, 'owner@example.com');
  const family = owner.books.find((b) => b.kind === 'family');
  const write = (doc) =>
    call(env, '/api/records', {
      method: 'POST',
      cookie: owner.cookie,
      profile: family.id,
      body: { collection: 'diary', doc },
    });

  await write({ title: 'Done already', dueAt: minutes(5), status: 'Completed' });
  await write({ title: 'Next week', dueAt: minutes(60 * 24 * 7), status: 'Pending' });
  const live = await write({ title: 'Soon', dueAt: minutes(3), status: 'Pending' });
  assert.equal(live.status, 200, live.text);

  const first = await call(env, '/api/alerts/due', { cookie: owner.cookie });
  assert.equal(first.data.items.length, 1, `expected one alert, got ${first.data.items.length}`);
  const second = await call(env, '/api/alerts/due', { cookie: owner.cookie });
  // The same deadline must produce the same id, or the phone would post it twice.
  assert.equal(second.data.items[0].id, first.data.items[0].id);
});
