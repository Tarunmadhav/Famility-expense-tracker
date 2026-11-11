// Contact import is allowed for exactly one account, in exactly one book.
//
// The allowlist lives in two Worker vars. These tests drive the real route, so
// they prove the gate rather than the hidden button.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
const OWNER = 'owner@example.com';

async function setup(overrides = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, overrides);
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
  return { cookie, books: (listed.data && listed.data.profiles) || [], email };
}

const docs = [
  { name: 'Amma', rel: 'Mother', mobile: '+91 98400 11111', email: 'amma@example.com' },
  { name: 'Appa', rel: 'Father', mobile: '+91 98400 22222', email: 'appa@example.com' },
];

test('the allowlisted account imports into the allowlisted book, once', async () => {
  const { env } = await setup();
  const owner = await account(env, OWNER);
  const family = owner.books.find((b) => b.kind === 'family');
  assert.ok(family, 'a family book exists');

  // Trimmed and case-insensitive, as the owner will type it by hand.
  env.CONTACT_IMPORT_EMAIL = `  ${OWNER.toUpperCase()}  `;
  env.CONTACT_IMPORT_BOOK = `  ${family.name.toUpperCase()}  `;

  const first = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { added: 2, skipped: 0 });

  // The same file again creates no copies.
  const again = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, { added: 0, skipped: 2 });

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM records WHERE space = ? AND collection = 'contacts'`,
  )
    .bind(family.id)
    .first();
  assert.equal(count.n, 2);
});

test('the client is handed a boolean, never the allowlisted address', async () => {
  const { env } = await setup();
  const owner = await account(env, OWNER);
  const family = owner.books.find((b) => b.kind === 'family');
  env.CONTACT_IMPORT_EMAIL = OWNER;
  env.CONTACT_IMPORT_BOOK = family.name;

  const allowed = await call(env, '/api/state?since=0', { cookie: owner.cookie, profile: family.id });
  assert.equal(allowed.data.canImportContacts, true);
  assert.ok(!allowed.text.toLowerCase().includes(OWNER), 'the address leaked into the state payload');

  const hidden = await setup();
  const plain = await account(hidden.env, 'plain@example.com');
  const plainFamily = plain.books.find((b) => b.kind === 'family');
  const off = await call(hidden.env, '/api/state?since=0', { cookie: plain.cookie, profile: plainFamily.id });
  assert.equal(off.data.canImportContacts, false);
});

test('any other account is refused with 403 and a generic message', async () => {
  const { env } = await setup();
  const owner = await account(env, OWNER);
  const family = owner.books.find((b) => b.kind === 'family');
  env.CONTACT_IMPORT_EMAIL = OWNER;
  env.CONTACT_IMPORT_BOOK = family.name;

  const other = await account(env, 'other@example.com', 'Other');
  const otherFamily = other.books.find((b) => b.kind === 'family');
  const res = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: other.cookie,
    profile: otherFamily.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.data.error), /not enabled/i);
  assert.ok(!String(res.text).toLowerCase().includes(OWNER), 'the refusal named the allowlisted account');

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM records WHERE space = ? AND collection = 'contacts'`,
  )
    .bind(otherFamily.id)
    .first();
  assert.equal(count.n, 0, 'a refused import wrote rows');
});

test('a book other than CONTACT_IMPORT_BOOK is refused, even for the allowlisted account', async () => {
  const { env } = await setup();
  const owner = await account(env, OWNER);
  const family = owner.books.find((b) => b.kind === 'family');
  const personal = owner.books.find((b) => b.kind === 'personal');
  env.CONTACT_IMPORT_EMAIL = OWNER;
  env.CONTACT_IMPORT_BOOK = family.name;

  const res = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: personal.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(res.status, 403);

  const state = await call(env, '/api/state?since=0', { cookie: owner.cookie, profile: personal.id });
  assert.equal(state.data.canImportContacts, false, 'the button must be hidden in the other book');
});

test('with the allowlist unset, contact import is off for everybody', async () => {
  const { env } = await setup();
  const owner = await account(env, OWNER);
  const family = owner.books.find((b) => b.kind === 'family');
  const res = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs },
  });
  assert.equal(res.status, 403);
});

test('a batch over the 500-row limit is rejected whole', async () => {
  const { env } = await setup();
  const owner = await account(env, OWNER);
  const family = owner.books.find((b) => b.kind === 'family');
  env.CONTACT_IMPORT_EMAIL = OWNER;
  env.CONTACT_IMPORT_BOOK = family.name;

  const big = Array.from({ length: 501 }, (_, i) => ({ name: `Person ${i}`, mobile: `+9198400${String(i).padStart(5, '0')}` }));
  const res = await call(env, '/api/records/bulk', {
    method: 'POST',
    cookie: owner.cookie,
    profile: family.id,
    body: { collection: 'contacts', docs: big },
  });
  assert.equal(res.status, 413);
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM records WHERE space = ? AND collection = 'contacts'`,
  )
    .bind(family.id)
    .first();
  assert.equal(count.n, 0, 'a refused batch must not have written anything');
});

test('the CLI refuses to run without both --email and --book, or outside the allowlist', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, ['scripts/import-contacts.mjs', ...args], {
      encoding: 'utf8',
      env: { ...process.env, CONTACT_IMPORT_EMAIL: '', CONTACT_IMPORT_BOOK: '', ...env },
    });

  const noArgs = run([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /--file is required/);

  const noBook = run(['--file', 'anything.csv', '--email', OWNER]);
  assert.equal(noBook.status, 1);
  assert.match(noBook.stderr, /--book is required/);

  const noEmail = run(['--file', 'anything.csv', '--book', 'Family']);
  assert.equal(noEmail.status, 1);
  assert.match(noEmail.stderr, /--email is required/);

  // Both given, but the deployment's allowlist is unknown to the script.
  const noAllowlist = run(['--file', 'anything.csv', '--email', OWNER, '--book', 'Family']);
  assert.equal(noAllowlist.status, 1);
  assert.match(noAllowlist.stderr, /CONTACT_IMPORT_EMAIL/);

  const wrongEmail = run(['--file', 'anything.csv', '--email', 'intruder@example.com', '--book', 'Family'], {
    CONTACT_IMPORT_EMAIL: OWNER,
    CONTACT_IMPORT_BOOK: 'Family',
  });
  assert.equal(wrongEmail.status, 1);
  assert.match(wrongEmail.stderr, /not the account this deployment allows/);

  const wrongBook = run(['--file', 'anything.csv', '--email', OWNER, '--book', 'Office'], {
    CONTACT_IMPORT_EMAIL: OWNER,
    CONTACT_IMPORT_BOOK: 'Family',
  });
  assert.equal(wrongBook.status, 1);
  assert.match(wrongBook.stderr, /not the book this deployment allows/);
});
