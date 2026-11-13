// The destructive demo routes are development-only.
//
// `Load sample data` and `Clear all data` were buttons in production Settings.
// Both routes now answer 404 unless APP_ENV=development, and the buttons are gone
// from the page, so a deployed planner cannot be wiped from the UI or the API.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';

async function call(env, path, { method = 'GET', cookie, profile, body } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (profile) headers['X-Profile'] = profile;
  if (body) headers['Content-Type'] = 'application/json';
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
  return { status: res.status, data };
}

async function setup(overrides = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, overrides);
  await applyMigrations(env);
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/signup`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'Password123', name: 'Owner' }),
    }),
    env,
    { waitUntil() {} },
  );
  const cookie = String(res.headers.get('set-cookie') || '').match(/ffp_session=[^;]+/)[0];
  const profiles = await call(env, '/api/profiles', { cookie });
  const book = (profiles.data.profiles || [])[0].id;
  const saved = await call(env, '/api/records', {
    method: 'POST',
    cookie,
    profile: book,
    body: { collection: 'diary', doc: { title: 'Placeholder task', due: '2026-11-20' } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return { db, env, cookie, book };
}

const count = (db) => db.prepare(`SELECT COUNT(*) AS n FROM records`).get().n;

test('a deployed planner does not offer the destructive routes at all', async () => {
  const { db, env, cookie, book } = await setup();
  for (const path of ['/api/admin/clear', '/api/admin/sample', '/api/admin/reset']) {
    const out = await call(env, path, { method: 'POST', cookie, profile: book });
    assert.equal(out.status, 404, `${path} answered ${out.status}`);
  }
  assert.equal(count(db), 1, 'a record was destroyed by a development-only route');
});

test('a signed-out caller is still refused by the session check first', async () => {
  const { env } = await setup();
  const out = await call(env, '/api/admin/clear', { method: 'POST' });
  assert.equal(out.status, 401);
});

test('development keeps the routes working for local work', async () => {
  const { db, env, cookie, book } = await setup({ APP_ENV: 'development' });
  const out = await call(env, '/api/admin/clear', { method: 'POST', cookie, profile: book });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(count(db), 0);
});
