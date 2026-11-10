// Isolation: two accounts on one deployment must never see each other's books,
// records, files or activity. Every route is exercised through the real Worker
// fetch handler with a real session cookie, so this covers the middleware as well
// as the queries it guards.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase, scalar } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';

function ctx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

async function call(env, path, { method = 'GET', body, cookie, profile } = {}) {
  const headers = { Origin: ORIGIN };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (profile) headers['X-Profile'] = profile;
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx(),
  );
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text for the assertion messages */
  }
  return { status: res.status, data, cookie: res.headers.get('set-cookie') };
}

function cookieOf(res) {
  const match = String(res.cookie || '').match(/ffp_session=[^;]+/);
  assert.ok(match, `expected a session cookie, got: ${res.cookie}`);
  return match[0];
}

async function signUp(env, email) {
  const res = await call(env, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'Password123', name: email.split('@')[0] },
  });
  assert.equal(res.status, 200, `signup ${email} failed: ${JSON.stringify(res.data)}`);
  return { cookie: cookieOf(res), userId: res.data.user.id };
}

/** Book ids the account can actually open, as the server reports them. */
async function books(env, cookie) {
  const res = await call(env, '/api/auth/account', { cookie });
  assert.equal(res.status, 200);
  return res.data.profiles.map((p) => p.id);
}

async function setup() {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  // ensureSchema carries a per-isolate "ready" flag, which is correct in a Worker
  // (one database per isolate) but would skip every database after the first here.
  await applyMigrations(env);
  const alice = await signUp(env, 'alice@example.com');
  const bob = await signUp(env, 'bob@example.com');
  return { db, env, alice, bob };
}

test('two accounts get separate books and never list each other', async () => {
  const { env, alice, bob } = await setup();
  const aliceBooks = await books(env, alice.cookie);
  const bobBooks = await books(env, bob.cookie);
  assert.ok(aliceBooks.length > 0 && bobBooks.length > 0);
  for (const id of aliceBooks) assert.ok(!bobBooks.includes(id), `book ${id} is shared between accounts`);

  const aliceState = await call(env, '/api/state', { cookie: alice.cookie });
  const bobState = await call(env, '/api/state', { cookie: bob.cookie });
  assert.equal(aliceState.status, 200);
  assert.equal(bobState.status, 200);
  const listed = (res) => res.data.profiles.map((p) => p.id).sort();
  assert.deepEqual(listed(bobState), bobBooks.slice().sort());
  assert.notDeepEqual(listed(aliceState), listed(bobState));
});

test('a record written in one account is invisible to the other, even by id', async () => {
  const { db, env, alice, bob } = await setup();
  const [aliceBook] = await books(env, alice.cookie);

  const created = await call(env, '/api/records', {
    method: 'POST',
    cookie: alice.cookie,
    profile: aliceBook,
    body: { collection: 'expenses', doc: { item: 'Alice private rent', cat: 'Rent', amount: 4200, date: '2026-11-02' } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.record && created.data.record.id;
  assert.ok(id, 'record id missing from the create response');

  // Bob's own state does not carry Alice's row, in either of his books.
  const bobBooks = await books(env, bob.cookie);
  for (const book of bobBooks) {
    const bobState = await call(env, '/api/state', { cookie: bob.cookie, profile: book });
    assert.equal(bobState.status, 200);
    assert.ok(!JSON.stringify(bobState.data).includes('Alice private rent'));
  }

  // Naming Alice's book explicitly is not a way in: the id is checked against
  // membership on every request, so it answers 404 rather than serving data.
  const peek = await call(env, '/api/state', { cookie: bob.cookie, profile: aliceBook });
  assert.ok(peek.status === 403 || peek.status === 404, `expected a refusal, got ${peek.status}`);
  assert.ok(!JSON.stringify(peek.data).includes('Alice private rent'));

  const steal = await call(env, `/api/records/expenses/${id}`, {
    method: 'DELETE',
    cookie: bob.cookie,
    profile: aliceBook,
  });
  assert.ok(steal.status === 403 || steal.status === 404, `delete went through: ${steal.status}`);

  // Both paths agree the row survived, and no second copy was created.
  const mine = await call(env, '/api/state', { cookie: alice.cookie, profile: aliceBook });
  assert.ok(JSON.stringify(mine.data).includes('Alice private rent'), 'Alice lost her own record');
  assert.equal(
    scalar(db, "SELECT COUNT(*) AS n FROM records WHERE collection = 'expenses' AND doc LIKE '%Alice private rent%'"),
    1,
  );
});

test('one account cannot read another account file by id', async () => {
  const { env, alice, bob } = await setup();
  const [aliceBook] = await books(env, alice.cookie);
  const fileId = '11111111-2222-4333-8444-555555555555';
  await env.DB.prepare(
    `INSERT INTO files (id, space, name, mime, size, key, uploaded_by, created_at)
     VALUES (?, ?, 'alice-bill.pdf', 'application/pdf', 10, ?, ?, 1)`,
  )
    .bind(fileId, aliceBook, `alice/${fileId}`, alice.userId)
    .run();

  const alien = await call(env, `/api/files/${fileId}`, { cookie: bob.cookie });
  assert.ok(alien.status === 403 || alien.status === 404, `file leaked with ${alien.status}`);
  assert.ok(!String(JSON.stringify(alien.data)).includes('alice-bill'), 'file metadata leaked to another account');
});

test('another account activity never appears in the audit trail', async () => {
  const { env, alice, bob } = await setup();
  const [aliceBook] = await books(env, alice.cookie);
  await call(env, '/api/records', {
    method: 'POST',
    cookie: alice.cookie,
    profile: aliceBook,
    body: { collection: 'expenses', doc: { item: 'Alice audit marker', amount: 10, date: '2026-11-03' } },
  });

  const bobActivity = await call(env, '/api/activity', { cookie: bob.cookie });
  assert.equal(bobActivity.status, 200);
  assert.ok(!JSON.stringify(bobActivity.data).includes(aliceBook), 'another account book id leaked in the audit trail');
});
