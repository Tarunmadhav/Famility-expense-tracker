// Contact import is open to every account, but only inside its own book.
//
// These tests drive the real route, because the point is the server's answer and
// not the button in the UI.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

/** Sign up and hand back the cookie plus the books the account can see. */
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

const docs = [
  { name: 'Amma', rel: 'Mother', mobile: '+91 98400 11111', email: 'amma@example.com' },
  { name: 'Appa', rel: 'Father', mobile: '+91 98400 22222', email: 'appa@example.com' },
];

const contactCount = async (env, space) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM records WHERE space = ? AND collection = 'contacts'`,
    )
      .bind(space)
      .first()
  ).n;

test('an ordinary account imports contacts into its own book, once', async () => {
  const { env } = await setup();
  const owner = await account(env, 'ordinary@example.com');
  const family = owner.books.find((b) => b.kind === 'family');

  const first = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { added: 2, skipped: 0 });

  // The same file again adds nothing: duplicates are caught inside the book.
  const again = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, { added: 0, skipped: 2 });
  assert.equal(await contactCount(env, family.id), 2);

  // Every other module still imports for every account too.
  const expenses = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'expenses', docs: [{ date: '2026-03-04', item: 'Coffee', amount: 120 }] },
  });
  assert.equal(expenses.status, 200);
});

test('one account cannot write into another account\u2019s book', async () => {
  const { env } = await setup();
  const alice = await account(env, 'alice@example.com', 'Alice');
  const bob = await account(env, 'bob@example.com', 'Bob');
  const aliceFamily = alice.books.find((b) => b.kind === 'family');

  // Bob names Alice's profile id directly. Membership is proved server-side, so
  // this is a 404 (not a 403: ids must not be probeable) and nothing is written.
  const stolen = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: bob.cookie,
    profile: aliceFamily.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(stolen.status, 404);
  assert.equal(await contactCount(env, aliceFamily.id), 0, 'a foreign write reached the book');

  // And the ordinary path writes to Bob's book only.
  const bobFamily = bob.books.find((b) => b.kind === 'family');
  const own = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: bob.cookie,
    profile: bobFamily.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(own.status, 200);
  assert.equal(await contactCount(env, bobFamily.id), 2);
  assert.equal(await contactCount(env, aliceFamily.id), 0);
});

test('the 5000-row limit still holds, and a refused batch writes nothing', async () => {
  const { env } = await setup();
  const owner = await account(env, 'limits@example.com');
  const family = owner.books.find((b) => b.kind === 'family');

  // 5001 rows should be rejected (over the 5000 limit)
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({
    name: `Person ${i}`,
    mobile: `+9198400${String(i).padStart(5, '0')}`,
  }));
  const rejected = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs: tooMany },
  });
  assert.equal(rejected.status, 413);
  assert.equal(await contactCount(env, family.id), 0, 'a refused batch wrote rows');

  // exactly 5000 rows should be accepted
  const exact = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs: tooMany.slice(0, 5000) },
  });
  assert.equal(exact.status, 200);
  assert.equal(exact.data.added, 5000);
});

test('the CLI still needs a file, an account and a book, and no allowlist', () => {
  const run = (args) =>
    spawnSync(process.execPath, ['scripts/import-contacts.mjs', ...args], {
      encoding: 'utf8',
      // A stray allowlist in the environment must not matter any more.
      env: { ...process.env, CONTACT_IMPORT_EMAIL: '', CONTACT_IMPORT_BOOK: '' },
    });

  const noArgs = run([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /--file is required/);

  const noEmail = run(['--file', 'anything.csv', '--book', 'Family']);
  assert.equal(noEmail.status, 1);
  assert.match(noEmail.stderr, /--email is required/);

  const noBook = run(['--file', 'anything.csv', '--email', 'person@example.com']);
  assert.equal(noBook.status, 1);
  assert.match(noBook.stderr, /--book is required/);

  // All three given: the script moves on to reading the file instead of refusing.
  const withArgs = run(['--file', 'no-such-file.csv', '--email', 'person@example.com', '--book', 'Family']);
  assert.equal(withArgs.status, 1);
  assert.ok(!/deployment allows/.test(withArgs.stderr), 'the allowlist check is gone');
  assert.match(withArgs.stderr + withArgs.stdout, /no-such-file|ENOENT|stop:/);
});
