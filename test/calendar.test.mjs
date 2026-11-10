// Calendar subscription: the token URL a calendar app polls has to serve the
// account's events, stop working when rotated, and never mix two accounts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
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
    /* the calendar body is not JSON */
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
  return { cookie, book: account.data.profiles[0].id };
}

async function setup() {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  await applyMigrations(env);
  const alice = await signUp(env, 'alice@example.com');
  const bob = await signUp(env, 'bob@example.com');
  return { db, env, alice, bob };
}

async function add(env, who, collection, doc) {
  const res = await call(env, '/api/records', {
    method: 'POST',
    cookie: who.cookie,
    profile: who.book,
    body: { collection, doc },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.record.id;
}

test('the feed serves the events the account owns, by token alone', async () => {
  const { env, alice } = await setup();
  await add(env, alice, 'insurance', { name: 'Family Health', renewal: '2026-12-01', premium: 18000 });
  await add(env, alice, 'diary', { title: 'Pay property tax', date: '2026-11-20', status: 'Pending' });
  await add(env, alice, 'payments', { payee: 'Electricity', amount: 2400, due: '2026-11-25', status: 'Unpaid' });
  // A settled bill must not appear: the feed is a to-do calendar, not a ledger.
  await add(env, alice, 'payments', { payee: 'Settled water', amount: 300, due: '2026-11-10', status: 'Paid' });

  const link = await call(env, '/api/calendar/feed', { cookie: alice.cookie });
  assert.equal(link.status, 200);
  const feedUrl = new URL(link.data.url);
  assert.match(feedUrl.pathname, /^\/api\/calendar\/[0-9a-f]{48}\.ics$/);

  // No cookie: a calendar client only sends the URL.
  const feed = await call(env, feedUrl.pathname);
  assert.equal(feed.status, 200);
  assert.match(feed.text, /^BEGIN:VCALENDAR/);
  assert.match(feed.text, /SUMMARY:Insurance renewal: Family Health/);
  assert.match(feed.text, /DTSTART;VALUE=DATE:20261201/);
  assert.match(feed.text, /SUMMARY:Task: Pay property tax/);
  assert.match(feed.text, /SUMMARY:Bill due: Electricity/);
  assert.ok(!feed.text.includes('Settled water'), 'a paid bill leaked into the feed');
  assert.match(feed.text, /BEGIN:VALARM/);
  assert.ok(feed.text.endsWith('END:VCALENDAR\r\n'));
});

test('an unknown token is a 404 and rotating retires the old URL', async () => {
  const { env, alice } = await setup();
  await add(env, alice, 'insurance', { name: 'Car', renewal: '2027-01-05' });

  const missing = await call(env, `/api/calendar/${'a'.repeat(48)}.ics`);
  assert.equal(missing.status, 404);
  assert.ok(!missing.text.includes('BEGIN:VCALENDAR'));

  const first = (await call(env, '/api/calendar/feed', { cookie: alice.cookie })).data.url;
  const firstPath = new URL(first).pathname;
  assert.equal((await call(env, firstPath)).status, 200);

  const rotated = await call(env, '/api/calendar/feed', { method: 'POST', cookie: alice.cookie });
  assert.equal(rotated.status, 200);
  const secondPath = new URL(rotated.data.url).pathname;
  assert.notEqual(secondPath, firstPath);
  assert.equal((await call(env, firstPath)).status, 404, 'the old URL still served events');
  assert.equal((await call(env, secondPath)).status, 200);
});

test('one account feed never contains another account events', async () => {
  const { env, alice, bob } = await setup();
  await add(env, alice, 'insurance', { name: 'Alice Only Policy', renewal: '2026-12-15' });
  await add(env, bob, 'insurance', { name: 'Bob Only Policy', renewal: '2026-12-16' });

  const aliceFeed = await call(env, new URL((await call(env, '/api/calendar/feed', { cookie: alice.cookie })).data.url).pathname);
  const bobFeed = await call(env, new URL((await call(env, '/api/calendar/feed', { cookie: bob.cookie })).data.url).pathname);

  assert.match(aliceFeed.text, /Alice Only Policy/);
  assert.ok(!aliceFeed.text.includes('Bob Only Policy'), 'another account event leaked');
  assert.match(bobFeed.text, /Bob Only Policy/);
  assert.ok(!bobFeed.text.includes('Alice Only Policy'), 'another account event leaked');
});

test('each book gets its own token and the feed shows only that book', async () => {
  const { env, alice } = await setup();
  const account = await call(env, '/api/auth/account', { cookie: alice.cookie });
  // The office book only carries work modules, so pick the two personal books.
  const books = account.data.profiles.filter((p) => p.kind !== 'office');
  assert.ok(books.length >= 2, 'the account needs a second book for this test');
  const [first, second] = books;

  await add(env, { ...alice, book: first.id }, 'insurance', { name: `Policy in ${first.name}`, renewal: '2026-12-20' });
  await add(env, { ...alice, book: second.id }, 'insurance', { name: `Policy in ${second.name}`, renewal: '2026-12-21' });

  const firstUrl = (await call(env, `/api/calendar/feed?profile=${first.id}`, { cookie: alice.cookie })).data.url;
  const secondUrl = (await call(env, `/api/calendar/feed?profile=${second.id}`, { cookie: alice.cookie })).data.url;
  assert.notEqual(firstUrl, secondUrl, 'both books shared one token');

  const firstFeed = await call(env, new URL(firstUrl).pathname);
  const secondFeed = await call(env, new URL(secondUrl).pathname);
  assert.match(firstFeed.text, new RegExp(`Policy in ${first.name}`));
  assert.ok(!firstFeed.text.includes(`Policy in ${second.name}`), 'the feed mixed two books');
  assert.match(secondFeed.text, new RegExp(`Policy in ${second.name}`));
  assert.ok(!secondFeed.text.includes(`Policy in ${first.name}`), 'the feed mixed two books');
});

test('another account cannot mint a feed for a book it does not belong to', async () => {
  const { env, alice, bob } = await setup();
  const res = await call(env, `/api/calendar/feed?profile=${alice.book}`, { cookie: bob.cookie });
  // 404 rather than 403: the API does not confirm that a profile exists.
  assert.equal(res.status, 404);
  assert.ok(!res.data.url, 'a foreign profile produced a subscription URL');
});

test('the feed needs a signed-in account to be created', async () => {
  const { env } = await setup();
  const res = await call(env, '/api/calendar/feed');
  assert.equal(res.status, 401);
});
