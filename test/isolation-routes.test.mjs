// Isolation, route by route.
//
// Every /api route that reads or writes a book is called twice: once by the owner
// (allowed) and once by a second account pointing at the owner's profile. The
// second call must be refused, and no route may return the owner's data. The test
// asserts on the actual response text, so a query that forgets its `space` clause
// fails here even when the status code looks right.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
const MARK = 'ALICESECRET';

function ctx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

async function call(env, path, { method = 'GET', body, cookie, profile, raw } = {}) {
  const headers = { Origin: ORIGIN };
  if (body || raw) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (profile) headers['X-Profile'] = profile;
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: raw ? raw : body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx(),
  );
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* binary or ics */
  }
  return { status: res.status, data, text, cookie: res.headers.get('set-cookie') };
}

async function signUp(env, email) {
  const res = await call(env, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'Password123', name: email.split('@')[0] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookie = String(res.cookie).match(/ffp_session=[^;]+/)[0];
  const account = await call(env, '/api/auth/account', { cookie });
  return { cookie, book: account.data.profiles[0].id, email };
}

async function setup() {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  const alice = await signUp(env, 'alice@example.com');
  const bob = await signUp(env, 'bob@example.com');

  const expense = await call(env, '/api/records', {
    method: 'POST',
    cookie: alice.cookie,
    profile: alice.book,
    body: { collection: 'expenses', doc: { item: `${MARK} coffee`, cat: 'Food', amount: 120, date: '2026-11-01' } },
  });
  assert.equal(expense.status, 200, JSON.stringify(expense.data));
  alice.expenseId = expense.data.record.id;

  alice.billId = (
    await call(env, '/api/records', {
      method: 'POST',
      cookie: alice.cookie,
      profile: alice.book,
      body: { collection: 'payments', doc: { payee: `${MARK} electricity`, amount: 2400, due: '2026-11-30', status: 'Unpaid' } },
    })
  ).data.record.id;

  await call(env, '/api/settings', {
    method: 'POST',
    cookie: alice.cookie,
    profile: alice.book,
    body: { mobile: '+919876500001', alertTime: '06:00', channel: `${MARK}-channel` },
  });

  await call(env, '/api/notifications', {
    method: 'POST',
    cookie: alice.cookie,
    profile: alice.book,
    body: { title: `${MARK} reminder`, body: 'Due tomorrow' },
  });

  return { db, env, alice, bob };
}

/* Every route here takes a profile; bob aims each one at alice's book. */
const FORBIDDEN = [
  ['GET', '/api/state'],
  ['GET', '/api/records?collection=expenses'],
  ['GET', '/api/records?collection=payments'],
  ['GET', '/api/files'],
  ['GET', '/api/notifications'],
  ['GET', '/api/activity'],
  ['GET', '/api/family/members'],
  ['GET', '/api/audit'],
  ['GET', '/api/export'],
  ['GET', '/api/backup'],
  ['GET', '/api/calendar/feed'],
];

test('no profile route answers a stranger, and none leaks the owner data', async () => {
  const { env, alice, bob } = await setup();
  for (const [method, path] of FORBIDDEN) {
    const asBob = await call(env, path, { method, cookie: bob.cookie, profile: alice.book });
    assert.ok(
      asBob.status === 403 || asBob.status === 404,
      `${method} ${path} answered ${asBob.status} to another account`,
    );
    assert.ok(!asBob.text.includes(MARK), `${method} ${path} leaked the owner's data`);
    assert.ok(!asBob.text.includes('+919876500001'), `${method} ${path} leaked the owner's number`);
  }
});

test('writes aimed at another book change nothing', async () => {
  const { env, alice, bob } = await setup();
  const before = (await call(env, '/api/state', { cookie: alice.cookie, profile: alice.book })).data;

  const writes = [
    [
      'POST',
      '/api/records',
      { collection: 'expenses', doc: { item: 'Bobs hidden paste', cat: 'Food', amount: 9, date: '2026-11-02' } },
    ],
    ['PATCH', '/api/records', { id: alice.expenseId, collection: 'expenses', doc: { item: 'Hijacked' } }],
    ['DELETE', '/api/records', { id: alice.expenseId, collection: 'expenses' }],
    ['POST', '/api/records/bulk', { collection: 'expenses', doc: [{ item: 'bulk', cat: 'Food', amount: 1, date: '2026-11-02' }] }],
    ['POST', '/api/settings', { household: 'bob', alertTime: '07:00', channel: 'bob' }],
    ['POST', '/api/notifications', { title: 'bob', body: 'bob' }],
    ['POST', '/api/notifications/read', { id: 'x' }],
    ['POST', '/api/calendar/feed'],
    ['POST', '/api/admin/clear', {}],
  ];
  for (const [method, path, body] of writes) {
    const res = await call(env, path, { method, cookie: bob.cookie, profile: alice.book, body });
    assert.ok(res.status >= 400 && res.status < 500, `${method} ${path} answered ${res.status}`);
  }

  const after = (await call(env, '/api/state', { cookie: alice.cookie, profile: alice.book })).data;
  assert.equal(after.collections.expenses.length, before.collections.expenses.length, 'a row was added or removed');
  assert.equal(after.collections.expenses[0].item, `${MARK} coffee`, 'the row was edited');
  assert.equal(after.settings.household, before.settings.household, 'the settings were overwritten');
  assert.ok(!JSON.stringify(after).includes('Bobs hidden paste'));
});

test('a record id from another account is not addressable by id alone', async () => {
  const { env, alice, bob } = await setup();
  const patch = await call(env, '/api/records', {
    method: 'PATCH',
    cookie: bob.cookie,
    profile: bob.book,
    body: { id: alice.expenseId, collection: 'expenses', doc: { item: 'Stolen' } },
  });
  assert.ok(patch.status === 404 || patch.status === 403, `PATCH by id answered ${patch.status}`);

  const del = await call(env, '/api/records', {
    method: 'DELETE',
    cookie: bob.cookie,
    profile: bob.book,
    body: { id: alice.expenseId, collection: 'expenses' },
  });
  assert.ok(del.status === 404 || del.status === 403, `DELETE by id answered ${del.status}`);

  const still = await call(env, '/api/state', { cookie: alice.cookie, profile: alice.book });
  assert.equal(still.data.collections.expenses[0].item, `${MARK} coffee`);
});

test('notifications, settings and calendar tokens stay with their account', async () => {
  const { env, alice, bob } = await setup();

  const bobNotes = await call(env, '/api/notifications', { cookie: bob.cookie, profile: bob.book });
  assert.ok(!bobNotes.text.includes(MARK), 'another account saw the notification');

  const bobSettings = await call(env, '/api/state', { cookie: bob.cookie, profile: bob.book });
  assert.equal(bobSettings.data.settings.mobile, '');
  assert.ok(!bobSettings.text.includes(MARK));

  const aliceFeed = (await call(env, '/api/calendar/feed', { cookie: alice.cookie, profile: alice.book })).data.url;
  const bobFeed = (await call(env, '/api/calendar/feed', { cookie: bob.cookie, profile: bob.book })).data.url;
  assert.notEqual(aliceFeed, bobFeed, 'two accounts shared a calendar token');

  const aliceBody = (await call(env, new URL(aliceFeed).pathname)).text;
  assert.match(aliceBody, new RegExp(MARK));
});

test('a signed-out request reaches no book at all', async () => {
  const { env, alice } = await setup();
  for (const [method, path] of FORBIDDEN) {
    const res = await call(env, path, { method, profile: alice.book });
    assert.equal(res.status, 401, `${method} ${path} answered ${res.status} without a session`);
    assert.ok(!res.text.includes(MARK));
  }
});
