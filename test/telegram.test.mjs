// Telegram: linking, identity rules, delivery and the webhook.
//
// No real bot is contacted: every Bot API call goes through a stub that records
// what would have been sent. The point is the rules around the message — who gets
// it, how much of it, how many times — not Telegram's own behaviour.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import {
  consumeLinkCode,
  createLinkCode,
  deliverPending,
  linkForUser,
  queueNotification,
  setPreview,
  unlinkTelegram,
} from '../src/telegram.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
const BOT = 'test-bot-token-not-real';
const SECRET = 'test-webhook-secret-not-real';

async function call(env, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const all = { Origin: ORIGIN, ...headers };
  if (body) all['Content-Type'] = 'application/json';
  if (cookie) all.Cookie = cookie;
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
  return { status: res.status, data, text, cookie: res.headers.get('set-cookie') };
}

async function setup(overrides = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: SECRET, ...overrides });
  await applyMigrations(env);
  return { db, env };
}

async function signup(env, email, name = 'Owner') {
  const res = await call(env, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'Password123', name },
  });
  const cookie = String(res.cookie).match(/ffp_session=[^;]+/)[0];
  const profiles = await call(env, '/api/profiles', { cookie });
  const family = profiles.data.profiles.find((p) => p.kind === 'family') || profiles.data.profiles[0];
  const user = env.DB ? null : null;
  return { cookie, family: family.id, name };
}

function addNotification(env, space, extra = {}) {
  const id = crypto.randomUUID();
  env.DB.prepare(
    `INSERT INTO notifications (id, space, type, title, body, level, collection, record_id, created_at, dedupe)
     VALUES (?, ?, 'bill_due', ?, ?, 'high', 'payments', NULL, ?, ?)`,
  )
    .bind(
      id,
      space,
      extra.title || 'Overdue by 2 days: Electricity bill',
      extra.body || '₹2,450 · UPI',
      Date.now(),
      `t:${id}`,
    )
    .run();
  return id;
}

/** A Bot API stub that records every call and answers with the given statuses. */
function botStub(statuses = [200]) {
  const sent = [];
  let i = 0;
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), chatId: body.chat_id, text: body.text });
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    const payload = status === 429 ? { ok: false, parameters: { retry_after: 5 } } : { ok: status === 200 };
    return new Response(JSON.stringify(payload), { status });
  };
  return { impl, sent };
}

test('a link code is stored only as a hash, works once, and expires', async () => {
  const { env, db } = await setup();
  const owner = await signup(env, 'owner@example.com');

  const issue = await call(env, '/api/telegram/link', { method: 'POST', cookie: owner.cookie });
  assert.equal(issue.status, 200);
  const code = issue.data.code;
  assert.match(code, /^[A-Z0-9]{10}$/);

  // Nothing in the table is the code itself.
  const dump = JSON.stringify(db.prepare(`SELECT * FROM telegram_codes`).all());
  assert.ok(!dump.includes(code), 'the link code was stored in a readable form');

  const first = await consumeLinkCode(env, code, { telegramUserId: '700000001', chatId: '700000001' });
  assert.equal(first.ok, true);

  const replay = await consumeLinkCode(env, code, { telegramUserId: '700000002', chatId: '700000002' });
  assert.equal(replay.ok, false, 'a consumed code worked twice');
  assert.equal(replay.reason, 'expired');

  // An expired but unused code is refused too.
  const second = await createLinkCode(env, first.userId);
  db.prepare(`UPDATE telegram_codes SET expires_at = ? WHERE used_at IS NULL`).run(Date.now() - 1000);
  const stale = await consumeLinkCode(env, second.code, { telegramUserId: '700000003', chatId: '700000003' });
  assert.equal(stale.ok, false);
});

test('one Telegram identity reaches one account, and one account has one identity', async () => {
  const { env } = await setup();
  const first = await signup(env, 'first@example.com', 'First');
  const second = await signup(env, 'second@example.com', 'Second');

  // Link through the public route so the account id comes from the session.
  const codeA = (await call(env, '/api/telegram/link', { method: 'POST', cookie: first.cookie })).data.code;
  const linked = await consumeLinkCode(env, codeA, { telegramUserId: '700000010', chatId: '700000010' });
  assert.equal(linked.ok, true);

  // Same Telegram identity, second planner account.
  const codeB = (await call(env, '/api/telegram/link', { method: 'POST', cookie: second.cookie })).data.code;
  const stolen = await consumeLinkCode(env, codeB, { telegramUserId: '700000010', chatId: '700000010' });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, 'identity-linked');

  // Same planner account, second Telegram identity.
  const codeC = (await call(env, '/api/telegram/link', { method: 'POST', cookie: first.cookie })).data.code;
  const extra = await consumeLinkCode(env, codeC, { telegramUserId: '700000011', chatId: '700000011' });
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, 'account-linked');
});

test('an alert reaches only the linked members of the book it belongs to', async () => {
  const { env } = await setup();
  const alice = await signup(env, 'alice@example.com', 'Alice');
  const bob = await signup(env, 'bob@example.com', 'Bob');

  const aliceLink = await consumeLinkCode(
    env,
    (await call(env, '/api/telegram/link', { method: 'POST', cookie: alice.cookie })).data.code,
    { telegramUserId: '700000020', chatId: '700000020' },
  );
  const bobLink = await consumeLinkCode(
    env,
    (await call(env, '/api/telegram/link', { method: 'POST', cookie: bob.cookie })).data.code,
    { telegramUserId: '700000021', chatId: '700000021' },
  );
  assert.equal(aliceLink.ok && bobLink.ok, true);

  const id = addNotification(env, alice.family);
  await queueNotification(env, { id, space: alice.family });

  const bot = botStub([200, 200]);
  await deliverPending(env, { fetchImpl: bot.impl, now: Date.now() });

  assert.equal(bot.sent.length, 1, 'the alert was sent to more than one household');
  assert.equal(bot.sent[0].chatId, '700000020');
});

test('the default message carries no amounts, and details are opt-in', async () => {
  const { env } = await setup();
  const alice = await signup(env, 'alice@example.com');
  const link = await consumeLinkCode(
    env,
    (await call(env, '/api/telegram/link', { method: 'POST', cookie: alice.cookie })).data.code,
    { telegramUserId: '700000030', chatId: '700000030' },
  );

  const first = addNotification(env, alice.family);
  await queueNotification(env, { id: first, space: alice.family });
  const generic = botStub([200]);
  await deliverPending(env, { fetchImpl: generic.impl, now: Date.now() });
  assert.match(generic.sent[0].text, /new planner alert/);
  assert.ok(!generic.sent[0].text.includes('2,450'), 'a generic preview leaked the amount');

  await setPreview(env, link.userId, 'detailed');
  const second = addNotification(env, alice.family);
  await queueNotification(env, { id: second, space: alice.family });
  const detailed = botStub([200]);
  await deliverPending(env, { fetchImpl: detailed.impl, now: Date.now() });
  assert.match(detailed.sent[0].text, /2,450/, 'the opt-in detail was not sent');
});

test('unlinking stops every future message and drops what was queued', async () => {
  const { env } = await setup();
  const alice = await signup(env, 'alice@example.com');
  const link = await consumeLinkCode(
    env,
    (await call(env, '/api/telegram/link', { method: 'POST', cookie: alice.cookie })).data.code,
    { telegramUserId: '700000040', chatId: '700000040' },
  );
  assert.equal((await linkForUser(env, link.userId)).chat_id, '700000040');

  const queued = addNotification(env, alice.family);
  await queueNotification(env, { id: queued, space: alice.family });

  const res = await call(env, '/api/telegram/unlink', { method: 'POST', cookie: alice.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.unlinked, true);
  assert.equal(await linkForUser(env, link.userId), null);

  const bot = botStub([200]);
  await deliverPending(env, { fetchImpl: bot.impl, now: Date.now() });
  assert.equal(bot.sent.length, 0, 'a revoked link still received an alert');
});

test('the webhook refuses a request without the right secret token', async () => {
  const { env } = await setup();
  const body = { update_id: 1, message: { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 5 }, text: '/start' } };

  const missing = await call(env, '/api/telegram/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  assert.equal(missing.status, 401);

  const wrong = await call(env, '/api/telegram/webhook', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'nope' },
  });
  assert.equal(wrong.status, 401);

  const unconfigured = await setup({ TELEGRAM_WEBHOOK_SECRET: '' });
  const off = await call(unconfigured.env, '/api/telegram/webhook', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'whatever' },
  });
  assert.equal(off.status, 501);
  assert.match(String(off.data.error), /TELEGRAM_WEBHOOK_SECRET/);
});

test('a signed webhook answers the chat and ignores a repeated update', async () => {
  const { env } = await setup();
  const update = {
    update_id: 99,
    message: { message_id: 7, chat: { id: 700000050, type: 'private' }, from: { id: 700000050 }, text: '/start' },
  };
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET };
    const first = await call(env, '/api/telegram/webhook', { method: 'POST', body: update, headers });
    assert.equal(first.status, 200);
    const again = await call(env, '/api/telegram/webhook', { method: 'POST', body: update, headers });
    assert.equal(again.status, 200);
    assert.equal(again.data.duplicate, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1, 'a retried update was answered twice');
  assert.match(sent[0].text, /\/link/);
});

test('group chats are refused, because a link belongs to one person', async () => {
  const { env } = await setup();
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await call(env, '/api/telegram/webhook', {
      method: 'POST',
      body: { update_id: 5, message: { chat: { id: -100, type: 'group' }, from: { id: 42 }, text: '/link ABC' } },
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /private chat/i);
});

test('403 blocks the chat, 400 fails it, 429 waits, and a 5xx retries without duplicates', async () => {
  const { env, db } = await setup();
  const alice = await signup(env, 'alice@example.com');
  const link = await consumeLinkCode(
    env,
    (await call(env, '/api/telegram/link', { method: 'POST', cookie: alice.cookie })).data.code,
    { telegramUserId: '700000060', chatId: '700000060' },
  );

  // 403: the person blocked the bot.
  const blockedId = addNotification(env, alice.family);
  await queueNotification(env, { id: blockedId, space: alice.family });
  const blocked = botStub([403]);
  await deliverPending(env, { fetchImpl: blocked.impl, now: Date.now() });
  const row = db.prepare(`SELECT status FROM telegram_deliveries WHERE notification_id = ?`).get(blockedId);
  assert.equal(row.status, 'blocked');
  assert.ok(
    Number(db.prepare(`SELECT blocked_at FROM telegram_links WHERE user_id = ?`).get(link.userId).blocked_at) > 0,
    'the link was not marked blocked',
  );

  // Nothing else is attempted for a blocked chat.
  const after = botStub([200]);
  const secondId = addNotification(env, alice.family);
  await queueNotification(env, { id: secondId, space: alice.family });
  await deliverPending(env, { fetchImpl: after.impl, now: Date.now() });
  assert.equal(after.sent.length, 0, 'a blocked chat was messaged again');

  // Re-linking clears the block; then a 429 schedules a retry instead of losing it.
  await env.DB.prepare(`UPDATE telegram_links SET blocked_at = NULL WHERE user_id = ?`).bind(link.userId).run();
  const limitedId = addNotification(env, alice.family);
  await queueNotification(env, { id: limitedId, space: alice.family });
  const limited = botStub([429]);
  await deliverPending(env, { fetchImpl: limited.impl, now: Date.now() });
  const retry = db.prepare(`SELECT status, attempts, next_try FROM telegram_deliveries WHERE notification_id = ?`).get(limitedId);
  assert.equal(retry.status, 'retry');
  assert.equal(retry.attempts, 1);
  assert.ok(retry.next_try > Date.now(), 'a rate-limited send was retried immediately');

  // 400 cannot be fixed by retrying.
  const badId = addNotification(env, alice.family);
  await env.DB.prepare(`UPDATE telegram_links SET blocked_at = NULL WHERE user_id = ?`).bind(link.userId).run();
  await queueNotification(env, { id: badId, space: alice.family });
  const bad = botStub([400]);
  await deliverPending(env, { fetchImpl: bad.impl, now: Date.now() });
  assert.equal(db.prepare(`SELECT status FROM telegram_deliveries WHERE notification_id = ?`).get(badId).status, 'failed');

  // 5xx: retried, and the second drain sends the retry exactly once.
  const flakyId = addNotification(env, alice.family);
  await env.DB.prepare(`UPDATE telegram_links SET blocked_at = NULL WHERE user_id = ?`).bind(link.userId).run();
  await queueNotification(env, { id: flakyId, space: alice.family });
  const flaky = botStub([500, 200]);
  await deliverPending(env, { fetchImpl: flaky.impl, now: Date.now() });
  assert.equal(db.prepare(`SELECT status FROM telegram_deliveries WHERE notification_id = ?`).get(flakyId).status, 'retry');

  // The retry becomes due immediately for this check, then succeeds once.
  await env.DB.prepare(`UPDATE telegram_deliveries SET next_try = 0 WHERE notification_id = ?`).bind(flakyId).run();
  const recover = botStub([200]);
  await deliverPending(env, { fetchImpl: recover.impl, now: Date.now() });
  assert.equal(recover.sent.length, 1);
  assert.equal(db.prepare(`SELECT status FROM telegram_deliveries WHERE notification_id = ?`).get(flakyId).status, 'sent');

  // A third drain has nothing left to do for that notification.
  const extra = botStub([200]);
  await deliverPending(env, { fetchImpl: extra.impl, now: Date.now() + 1000 });
  assert.equal(extra.sent.length, 0, 'a delivered alert was sent twice');
});

test('linking and commands are rate limited per Telegram user', async () => {
  const { env } = await setup();
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    for (let i = 0; i < 31; i += 1) {
      await call(env, '/api/telegram/webhook', {
        method: 'POST',
        body: { update_id: 1000 + i, message: { chat: { id: 700000070, type: 'private' }, from: { id: 700000070 }, text: `/link BADCODE${i}` } },
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  // The last few updates are dropped by the limiter instead of hammering the bot.
  assert.ok(sent.length < 31, 'the rate limiter never engaged');
  assert.ok(sent.length >= 25);
});

test('the card can link straight to the bot, and a bad username is dropped', async () => {
  const { env } = await setup({ TELEGRAM_BOT_USERNAME: '@FamilyFinancePlanner_bot' });
  const { cookie } = await signup(env, 'tg-user@example.com');
  const state = await call(env, '/api/telegram', { cookie });
  assert.equal(state.status, 200);
  // Leading @ and case are Telegram's, not ours: the link needs it without the @.
  assert.equal(state.data.botUsername, 'FamilyFinancePlanner_bot');

  const bad = await setup({ TELEGRAM_BOT_USERNAME: 'not a username' });
  const badUser = await signup(bad.env, 'tg-bad@example.com');
  const badState = await call(bad.env, '/api/telegram', { cookie: badUser.cookie });
  assert.equal(badState.data.botUsername, '');
});
