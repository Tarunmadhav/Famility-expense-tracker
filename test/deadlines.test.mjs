// Task deadlines: the due moment, the top banner, and the 15-minute reminder.
//
// No real bot and no real clock is touched: the Bot API is stubbed and the
// reminder job takes an explicit `now`. Placeholder titles only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { remindDueTasks } from '../src/store.js';
import { consumeLinkCode, deliverPending } from '../src/telegram.js';
import { deadlineItems, momentFromLocal } from '../web/src/deadlines.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
const BOT = 'test-bot-token-not-real';
const SECRET = 'test-webhook-secret-not-real';

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
    /* empty */
  }
  return { status: res.status, data };
}

async function setup(overrides = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: SECRET, ...overrides });
  await applyMigrations(env);
  return { db, env };
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
  const jar = String(res.headers.get('set-cookie') || '').match(/ffp_session=[^;]+/);
  assert.ok(jar, 'signup did not return a session cookie');
  const cookie = jar[0];
  const profiles = await call(env, '/api/profiles', { cookie });
  const family = (profiles.data.profiles || []).find((p) => p.kind === 'family') || profiles.data.profiles[0];
  return { cookie, book: family.id };
}

async function addTask(env, who, doc) {
  return call(env, '/api/records', {
    method: 'POST',
    cookie: who.cookie,
    profile: who.book,
    body: { collection: 'diary', doc },
  });
}

/* ------------------------------------------------------------- the model */

test('a task with a date and a time saves and reads back', async () => {
  const { env } = await setup();
  const owner = await account(env, 'owner@example.com');
  const saved = await addTask(env, owner, {
    title: 'Pay water bill',
    date: '2026-11-12',
    due: '2026-11-12',
    dueTime: '18:00',
    dueAt: momentFromLocal('2026-11-12', '18:00'),
    status: 'Pending',
    priority: 'Low',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.record.dueTime, '18:00');
  assert.equal(saved.data.record.due, '2026-11-12');
  // Stored as a real UTC instant, not a date string.
  assert.match(saved.data.record.dueAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const state = await call(env, '/api/state?since=0', { cookie: owner.cookie, profile: owner.book });
  const row = state.data.collections.diary.find((t) => t.id === saved.data.record.id);
  assert.equal(row.dueTime, '18:00');
  assert.equal(row.dueAt, saved.data.record.dueAt);
});

test('a task with a date only is all-day and keeps its row valid', async () => {
  const { env } = await setup();
  const owner = await account(env, 'allday@example.com');
  const saved = await addTask(env, owner, { title: 'Renew library card', date: '2026-11-12', due: '2026-11-12' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.record.dueTime, '');
  assert.equal(saved.data.record.dueAt, '');

  const now = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const items = deadlineItems([saved.data.record], now);
  assert.equal(items.length, 1);
  assert.equal(items[0].allDay, true);
  assert.equal(items[0].overdue, false, 'an all-day task is not late during its own day');
});

test('an invalid due moment is rejected, and a bad clock time is dropped', async () => {
  const { env } = await setup();
  const owner = await account(env, 'invalid@example.com');

  const badDate = await addTask(env, owner, { title: 'Task', due: '2026-11-12', dueAt: '2026-11-12' });
  assert.equal(badDate.status, 400, 'a date-only dueAt was accepted as an instant');

  const nonsense = await addTask(env, owner, { title: 'Task', due: '2026-11-12', dueAt: 'not-a-moment' });
  assert.equal(nonsense.status, 400);

  const noZone = await addTask(env, owner, { title: 'Task', due: '2026-11-12', dueAt: '2026-11-12T18:00:00' });
  assert.equal(noZone.status, 400);

  // 25:00 is not a time; it is cleared rather than stored as text.
  const oddTime = await addTask(env, owner, { title: 'Task', due: '2026-11-12', dueTime: '25:00' });
  assert.equal(oddTime.status, 200);
  assert.equal(oddTime.data.record.dueTime, '');
});

test('a non-member cannot set the time on another account task', async () => {
  const { env } = await setup();
  const alice = await account(env, 'alice@example.com', 'Alice');
  const bob = await account(env, 'bob@example.com', 'Bob');
  const created = await addTask(env, alice, { title: 'Alice task', due: '2026-11-12' });
  assert.equal(created.status, 200);
  const id = created.data.record.id;

  // Bob names Alice's book directly; membership is proved server-side.
  const stolen = await call(env, `/api/records/diary/${id}`, {
    method: 'PATCH',
    cookie: bob.cookie,
    profile: alice.book,
    body: { doc: { dueTime: '09:00', dueAt: momentFromLocal('2026-11-12', '09:00') } },
  });
  assert.equal(stolen.status, 404);

  const after = await call(env, '/api/state?since=0', { cookie: alice.cookie, profile: alice.book });
  const row = after.data.collections.diary.find((t) => t.id === id);
  assert.equal(row.dueTime, '', 'a foreign write changed the task');
  assert.equal(row.dueAt, '');
});

/* ------------------------------------------------------------- the banner */

test('the banner lists overdue and soon tasks only, newest deadline last', async () => {
  const now = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
  const tasks = [
    { id: 'soon', title: 'Soon task', dueAt: at(12, 20), status: 'Pending' },
    { id: 'overdue', title: 'Late task', dueAt: at(12, 8), status: 'Pending' },
    { id: 'today', title: 'Tonight task', dueAt: at(12, 23), status: 'Pending' },
    { id: 'later', title: 'Next week task', dueAt: at(15, 9), status: 'Pending' },
    { id: 'done', title: 'Finished task', dueAt: at(12, 8), status: 'Completed' },
    { id: 'undated', title: 'Someday task', status: 'Pending' },
  ];
  const items = deadlineItems(tasks, now);
  assert.deepEqual(items.map((i) => i.id), ['overdue', 'soon', 'today']);
  assert.equal(items[0].overdue, true);
  assert.equal(items[1].overdue, false);

  // The strip is text only: no amounts, no balances.
  const source = readFileSync(new URL('../web/src/views.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const banner = source.slice(source.indexOf('export function deadlineBannerHtml'));
  const body = banner.slice(0, banner.indexOf('\n}\n'));
  assert.ok(body.length > 0, 'deadlineBannerHtml not found');
  assert.ok(!body.includes('\u20b9'), 'the banner renders a currency symbol');
  assert.ok(!/\bmoney\s*\(/.test(body), 'the banner renders an amount');
});

test('the banner stays empty when nothing is due', async () => {
  const now = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const items = deadlineItems(
    [{ id: 'a', title: 'Next month', dueAt: new Date(2026, 11, 20, 9).toISOString(), status: 'Pending' }],
    now,
  );
  assert.deepEqual(items, []);
});

/* ----------------------------------------------------------- the reminder */

/** A Bot API stub that records what would be sent, per chat. */
function botStub(statusFor = () => 200) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ chatId: String(body.chat_id), text: String(body.text) });
    const status = statusFor(String(body.chat_id));
    return new Response(JSON.stringify({ ok: status === 200 }), { status });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function linkChat(env, who, telegramUserId) {
  const issued = await call(env, '/api/telegram/link', { method: 'POST', cookie: who.cookie, profile: who.book });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  const out = await consumeLinkCode(env, issued.data.code, {
    telegramUserId,
    chatId: telegramUserId,
  });
  assert.equal(out.ok, true);
}

const MINUTE = 60 * 1000;

test('a task reminder is sent once, with generic text by default', async () => {
  const { env, db } = await setup();
  const owner = await account(env, 'remind@example.com');
  await linkChat(env, owner, '700000101');

  const now = Date.now();
  const dueAt = new Date(now + 5 * MINUTE).toISOString();
  const saved = await addTask(env, owner, { title: 'Placeholder task', due: '2026-11-12', dueTime: '18:00', dueAt });
  assert.equal(saved.status, 200);

  const stub = botStub();
  try {
    const first = await remindDueTasks(env, { now });
    assert.equal(first.length, 1, 'no reminder was created for a task due in five minutes');
    await deliverPending(env, { now });
    assert.equal(stub.sent.length, 1, JSON.stringify(stub.sent));

    // The delivery row proves the reminder was recorded, so no later drain can
    // send it again even if it starts from a different code path.
    const delivered = db.prepare(`SELECT status FROM telegram_deliveries`).all();
    assert.deepEqual(delivered.map((d) => d.status), ['sent']);

    // Generic is the default: the alert says there is one, without the detail.
    assert.match(stub.sent[0].text, /new planner alert/);
    assert.ok(!stub.sent[0].text.includes('Placeholder task'), 'the default message leaked the task title');

    // A second run inside the same window must not send again.
    const second = await remindDueTasks(env, { now: now + 1000 });
    assert.equal(second.length, 0, 'the reminder was queued twice');
    await deliverPending(env, { now: now + 1000 });
    assert.equal(stub.sent.length, 1);
  } finally {
    stub.restore();
  }
});

test('a blocked chat does not stop the other reminders', async () => {
  const { env } = await setup();
  const first = await account(env, 'blocked@example.com', 'First');
  const second = await account(env, 'open@example.com', 'Second');
  await linkChat(env, first, '700000201');
  await linkChat(env, second, '700000202');

  const now = Date.now();
  const dueAt = new Date(now + 5 * MINUTE).toISOString();
  // Both accounts hold their own book, so this is two separate reminders; the
  // blocked one must not prevent the other from being created and delivered.
  await addTask(env, first, { title: 'First task', due: '2026-11-12', dueAt });
  await addTask(env, second, { title: 'Second task', due: '2026-11-12', dueAt });

  const stub = botStub((chatId) => (chatId === '700000201' ? 403 : 200));
  try {
    const created = await remindDueTasks(env, { now });
    assert.equal(created.length, 2);
    await deliverPending(env, { now });
    const toOpen = stub.sent.filter((m) => m.chatId === '700000202');
    assert.equal(toOpen.length, 1, 'the 403 chat stopped the other reminder');
  } finally {
    stub.restore();
  }
});

test('a reminder never reaches a chat outside the task profile', async () => {
  const { env } = await setup();
  const owner = await account(env, 'outsider@example.com', 'Owner');
  const stranger = await account(env, 'stranger@example.com', 'Stranger');
  await linkChat(env, stranger, '700000301');

  const now = Date.now();
  await addTask(env, owner, {
    title: 'Private task',
    due: '2026-11-12',
    dueAt: new Date(now + 5 * MINUTE).toISOString(),
  });

  const stub = botStub();
  try {
    await remindDueTasks(env, { now });
    await deliverPending(env, { now });
    assert.equal(stub.sent.length, 0, 'a stranger chat received the reminder');
  } finally {
    stub.restore();
  }
});

test('a task due beyond the reminder window is not announced yet', async () => {
  const { env } = await setup();
  const owner = await account(env, 'later@example.com');
  await linkChat(env, owner, '700000401');

  const now = Date.now();
  await addTask(env, owner, {
    title: 'Later task',
    due: '2026-11-12',
    dueAt: new Date(now + 40 * MINUTE).toISOString(),
  });

  const stub = botStub();
  try {
    const created = await remindDueTasks(env, { now });
    assert.deepEqual(created, []);
    await deliverPending(env, { now });
    assert.equal(stub.sent.length, 0);
  } finally {
    stub.restore();
  }
});
