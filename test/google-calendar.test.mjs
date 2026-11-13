// Google Calendar sync.
//
// Every Google call is stubbed: no real account is touched, and no test needs a
// network. What is checked is the wiring — the scope, the state, the sealed
// refresh token, one event per task, backoff on 429/5xx, and the promise that
// disconnecting stops sync.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import { sealToken } from '../src/backupcrypto.js';
import {
  MAX_ATTEMPTS,
  calendarRow,
  eventRow,
  finishCalendarConnect,
  retryCalendarSync,
  startCalendarConnect,
  syncTask,
  unlinkCalendar,
} from '../src/calendar.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
const BACKUP_KEY = '3xkHIItGG0-ExLXWjow78iOAAHZOZimTarK7FuYMpy0';
const CAL = 'cal-app-created';

async function call(env, path, { method = 'GET', body, cookie, profile, headers = {} } = {}) {
  const all = { Origin: ORIGIN, ...headers };
  if (body) all['Content-Type'] = 'application/json';
  if (cookie) all.Cookie = cookie;
  if (profile) all['X-Profile'] = profile;
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers: all, body: body ? JSON.stringify(body) : undefined }),
    env,
    { waitUntil() {} },
  );
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* redirect or empty */
  }
  return { status: res.status, data, location: res.headers.get('Location') };
}

async function signup(env, db, email) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/signup`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123', name: 'Owner' }),
    }),
    env,
    { waitUntil() {} },
  );
  const cookie = String(res.headers.get('set-cookie') || '').match(/ffp_session=[^;]+/)[0];
  const profiles = await call(env, '/api/profiles', { cookie });
  const book = (profiles.data.profiles || []).find((p) => p.kind === 'family') || profiles.data.profiles[0];
  const id = db.prepare(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`).get().id;
  return { cookie, book: book.id, id };
}

async function setup(overrides = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, {
    BACKUP_KEY,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ...overrides,
  });
  await applyMigrations(env);
  const owner = await signup(env, db, 'owner@example.com');
  return { db, env, owner };
}

/**
 * A stub Google: methods answer from a table of matchers, in order. `calls`
 * records what was asked for so a test can prove "one insert, no duplicate".
 */
function stubGoogle(table, { tokenFails = 0 } = {}) {
  const calls = [];
  let tokenFailures = tokenFails;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      if (tokenFailures > 0) {
        tokenFailures -= 1;
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes('oauth2.googleapis.com/revoke')) return new Response('', { status: 200 });
    for (const { method: wants, test, reply } of table) {
      if (wants && wants !== method) continue;
      if (!test.test(String(url))) continue;
      const [status, payload] = reply;
      return new Response(payload == null ? '' : JSON.stringify(payload), { status });
    }
    return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
  };
  fetchImpl.calls = calls;
  fetchImpl.count = (re, method) =>
    calls.filter((c) => re.test(c.url) && (!method || c.method === method)).length;
  return fetchImpl;
}

/** A connected book whose stored access token is already valid. */
async function connect(env, space, { detail = 0, expiresIn = 3600_000 } = {}) {
  const sealed = await sealToken(env, 'refresh-token-for-test');
  const uid = (await env.DB.prepare(`SELECT id FROM users LIMIT 1`).first()).id;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO google_calendars (profile_id, user_id, calendar_id, refresh_token, access_token, expires_at, detail, created_at)
     VALUES (?, ?, ?, ?, 'live-token', ?, ?, ?)`,
  )
    .bind(space, uid, CAL, sealed, Date.now() + expiresIn, detail, Date.now())
    .run();
}

const OK_CREATE_CAL = [{ method: 'POST', test: /\/calendar\/v3\/calendars$/, reply: [200, { id: CAL }] }];

const task = (extra = {}) => ({
  id: 't1',
  title: 'Pay water bill',
  due: '2026-11-20',
  dueTime: '09:00',
  dueAt: '2026-11-20T03:30:00.000Z',
  status: 'Pending',
  notes: 'Placeholder note',
  ...extra,
});

test('the consent URL asks only for the app-created scope, with PKCE and state', async () => {
  const { env, owner } = await setup();
  const link = await call(env, '/api/calendar/google/link', { method: 'POST', cookie: owner.cookie, profile: owner.book });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const url = new URL(link.data.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.match(url.searchParams.get('scope'), /calendar\.app\.created/);
  assert.ok(!/auth\/calendar$/.test(url.searchParams.get('scope')), 'asked for every calendar');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(url.searchParams.get('state'));
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/calendar/callback/google`);
  assert.equal(url.searchParams.get('access_type'), 'offline');
});

test('a non-owner cannot connect the book calendar', async () => {
  const { db, env, owner } = await setup();
  const member = await signup(env, db, 'member@example.com');
  const memberId = db.prepare(`SELECT user_id FROM credentials WHERE email = ?`).get('member@example.com').user_id;
  await env.DB.prepare(`INSERT OR REPLACE INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, 'editor', ?)`)
    .bind(owner.book, memberId, Date.now())
    .run();
  const link = await call(env, '/api/calendar/google/link', { method: 'POST', cookie: member.cookie, profile: owner.book });
  assert.equal(link.status, 403, JSON.stringify(link.data));
  // Refused by the role table before any consent URL exists.
  assert.ok(!link.data.url, 'an editor was handed a consent URL');
  assert.equal(
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM google_calendars`).first()).n,
    0,
  );
});

test('an unconfigured deployment names the missing setting', async () => {
  const { env, owner } = await setup({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
  const link = await call(env, '/api/calendar/google/link', { method: 'POST', cookie: owner.cookie, profile: owner.book });
  assert.equal(link.status, 501);
  assert.match(link.data.error, /GOOGLE_CLIENT_ID/);
  const state = await call(env, '/api/calendar/google', { cookie: owner.cookie, profile: owner.book });
  assert.equal(state.data.configured, false);
});

test('a task with a due time creates one event and remembers its id', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  const google = stubGoogle([
    ...OK_CREATE_CAL,
    { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-1' }] },
  ]);
  const out = await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  assert.equal(out.status, 'created', JSON.stringify(out));
  const row = await eventRow(env, owner.book, 't1');
  assert.equal(row.event_id, 'ev-1');
  assert.equal(row.attempts, 0);
  const inserted = google.calls.find((c) => c.method === 'POST' && /\/events$/.test(c.url));
  const body = JSON.parse(inserted.body);
  assert.equal(body.summary, 'Task due: Pay water bill');
  assert.ok(!/Amount:/.test(body.description), 'amount leaked with detail off');
});

test('a re-sync updates the same event and never creates a second one', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  const google = stubGoogle([
    ...OK_CREATE_CAL,
    { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-1' }] },
    { method: 'PATCH', test: /\/events\/ev-1$/, reply: [200, { id: 'ev-1' }] },
  ]);
  await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  const again = await syncTask(env, {
    space: owner.book,
    recordId: 't1',
    doc: task({ title: 'Pay water bill now' }),
    fetchImpl: google,
  });
  assert.equal(again.status, 'updated');
  assert.equal(google.count(/\/events$/, 'POST'), 1, 'a second insert was made');
  assert.equal(google.count(/\/events\/ev-1$/, 'PATCH'), 1);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM google_events`).first()).n, 1);
});

test('deleting the task deletes its event', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  const google = stubGoogle([
    ...OK_CREATE_CAL,
    { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-1' }] },
    { method: 'DELETE', test: /\/events\/ev-1$/, reply: [200, null] },
  ]);
  await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  const out = await syncTask(env, { space: owner.book, recordId: 't1', op: 'delete', fetchImpl: google });
  assert.equal(out.status, 'deleted', JSON.stringify(out));
  assert.equal(google.count(/\/events\/ev-1$/, 'DELETE'), 1);
  assert.equal(await eventRow(env, owner.book, 't1'), null);
});

test('completing a task removes its event instead of leaving a stale one', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  const google = stubGoogle([
    ...OK_CREATE_CAL,
    { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-1' }] },
    { method: 'DELETE', test: /\/events\/ev-1$/, reply: [200, null] },
  ]);
  await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  const done = await syncTask(env, {
    space: owner.book,
    recordId: 't1',
    doc: task({ status: 'Completed' }),
    fetchImpl: google,
  });
  assert.equal(done.status, 'not-due', JSON.stringify(done));
  assert.equal(google.count(/\/events\/ev-1$/, 'DELETE'), 1);
});

test('an expired access token is refreshed before the call', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book, { expiresIn: -60_000 });
  const google = stubGoogle([
    ...OK_CREATE_CAL,
    { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-9' }] },
  ]);
  const out = await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  assert.equal(out.status, 'created', JSON.stringify(out));
  assert.equal(google.count(/oauth2\.googleapis\.com\/token$/, 'POST'), 1);
  const row = await calendarRow(env, owner.book);
  assert.equal(row.access_token, 'access-token');
});

test('a 429 is retried on a backoff and then succeeds', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  const failing = stubGoogle([...OK_CREATE_CAL, { method: 'POST', test: /\/events$/, reply: [429, { error: 'rate' }] }]);
  const first = await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: failing, now: 1_000_000 });
  assert.equal(first.status, 'failed', JSON.stringify(first));
  const row = await eventRow(env, owner.book, 't1');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_try > 1_000_000, 'no backoff was scheduled');
  assert.match(row.error, /429/);

  // The cron reads the task from the database, so it has to exist there.
  await env.DB.prepare(
    `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by)
     VALUES (?, 'diary', 't1', ?, 1, ?, 'test')`,
  )
    .bind(owner.book, JSON.stringify(task()), Date.now())
    .run();
  const working = stubGoogle([...OK_CREATE_CAL, { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-2' }] }]);
  const retried = await retryCalendarSync(env, { now: row.next_try + 1, fetchImpl: working });
  assert.equal(retried.retried, 1);
  const after = await eventRow(env, owner.book, 't1');
  assert.equal(after.event_id, 'ev-2');
  assert.equal(after.attempts, 0);
});

test('a 503 keeps failing, and after the last attempt it stops retrying', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  await env.DB.prepare(
    `INSERT INTO google_events (space, collection, record_id, event_id, attempts, next_try, error, updated_at)
     VALUES (?, 'diary', 't1', NULL, ?, 1, 'Google Calendar rejected the event (HTTP 503)', ?)`,
  )
    .bind(owner.book, MAX_ATTEMPTS - 1, Date.now())
    .run();
  await env.DB.prepare(
    `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by) VALUES (?, 'diary', 't1', ?, 1, ?, 'test')`,
  )
    .bind(owner.book, JSON.stringify(task()), Date.now())
    .run();
  const failing = stubGoogle([{ method: 'POST', test: /\/events$/, reply: [503, { error: 'unavailable' }] }]);
  await retryCalendarSync(env, { now: Date.now() + 10, fetchImpl: failing });
  const row = await eventRow(env, owner.book, 't1');
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.next_try, 0, 'a used-up mapping must stop scheduling retries');
  const conn = await calendarRow(env, owner.book);
  assert.match(conn.last_error, /503/, 'Settings has no last error to show');

  const more = await retryCalendarSync(env, { now: Date.now() + 10_000_000, fetchImpl: failing });
  assert.equal(more.retried, 0);
});

test('disconnecting revokes the token, deletes it, and stops sync', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book);
  const google = stubGoogle([...OK_CREATE_CAL, { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-1' }] }]);
  await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  const out = await unlinkCalendar(env, owner.book, google);
  assert.equal(out.unlinked, true);
  assert.equal(out.revoked, true);
  assert.equal(google.count(/revoke/, 'POST'), 1);
  assert.equal(await calendarRow(env, owner.book), null);
  assert.equal((await env.DB.prepare(`SELECT COUNT(*) AS n FROM google_events`).first()).n, 0);
  const after = await syncTask(env, { space: owner.book, recordId: 't1', doc: task(), fetchImpl: google });
  assert.equal(after.status, 'not-connected');
  assert.equal(google.count(/\/events$/, 'POST'), 1, 'sync kept running after disconnect');
});

test('amounts appear only when the book turned detail on', async () => {
  const { env, owner } = await setup();
  await connect(env, owner.book, { detail: 1 });
  const google = stubGoogle([...OK_CREATE_CAL, { method: 'POST', test: /\/events$/, reply: [200, { id: 'ev-3' }] }]);
  await syncTask(env, { space: owner.book, recordId: 't1', doc: task({ amount: 450 }), fetchImpl: google });
  const body = JSON.parse(google.calls.find((c) => c.method === 'POST' && /\/events$/.test(c.url)).body);
  assert.match(body.description, /Amount: 450/);
});

test('the code exchange seals the refresh token and burns the state', async () => {
  const { env, owner } = await setup();
  const started = await startCalendarConnect(env, {
    userId: owner.id,
    profileId: owner.book,
    redirectUri: `${ORIGIN}/api/calendar/callback/google`,
  });
  const token = new URL(started.url).searchParams.get('state');
  const google = stubGoogle([], {});
  google.calls.push = google.calls.push.bind(google.calls);
  const fetchImpl = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(options.body));
      assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{20,}$/);
      assert.equal(body.get('grant_type'), 'authorization_code');
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response('', { status: 404 });
  };
  const linked = await finishCalendarConnect(env, 'code-1', token, fetchImpl);
  assert.equal(linked.profileId, owner.book);
  assert.match(linked.sealedRefresh, /^v1\./);
  await assert.rejects(finishCalendarConnect(env, 'code-1', token, fetchImpl), /expired/);
});
