// Cloud backup quick-connect.
//
// The provider is stubbed (no real Google or Microsoft account is touched); what is
// checked is the wiring the credentials turn on: the consent URL, the state, the
// code exchange, the sealed refresh token, and the round trip back into the app.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import { startConnect } from '../src/cloud.js';
import worker from '../src/worker.js';
import { makeDatabase } from './helpers/d1.mjs';

const ORIGIN = 'http://localhost:8787';
// 32 bytes, base64url — the shape BACKUP_KEY must have.
const BACKUP_KEY = '3xkHIItGG0-ExLXWjow78iOAAHZOZimTarK7FuYMpy0';

// `origin: null` drops the Origin header and `site` sets Sec-Fetch-Site, which is
// how a top-level redirect back from the provider looks: no Origin, cross-site.
async function call(env, path, { method = 'GET', body, cookie, redirect = 'manual', origin = ORIGIN, site } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (site) headers['Sec-Fetch-Site'] = site;
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect }),
    env,
    { waitUntil() {} },
  );
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* html or empty */
  }
  return { status: res.status, data, text, cookie: res.headers.get('set-cookie'), location: res.headers.get('Location') };
}

async function setup(env0 = {}) {
  const { db, env } = makeDatabase();
  env.APP_VERSION = 'test';
  Object.assign(env, {
    BACKUP_KEY,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ...env0,
  });
  await applyMigrations(env);
  const signup = await call(env, '/api/auth/signup', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'Password123', name: 'Owner' },
  });
  const cookie = String(signup.cookie).match(/ffp_session=[^;]+/)[0];
  const userId = db.prepare(`SELECT id FROM users`).get().id;
  return { db, env, cookie, userId };
}

test('an unconfigured deployment says which secret is missing and offers no connect', async () => {
  const { env, cookie } = await setup({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
  const state = await call(env, '/api/cloud', { cookie });
  const google = state.data.providers.find((p) => p.id === 'google');
  assert.equal(google.configured, false);

  const link = await call(env, '/api/cloud/link', { method: 'POST', cookie, body: { provider: 'google' } });
  assert.equal(link.status, 501);
  assert.match(link.data.error, /GOOGLE_CLIENT_ID/);
  assert.ok(!link.data.url, 'an unconfigured provider produced a consent URL');
});

test('connecting with credentials produces one consent URL with PKCE and state', async () => {
  const { env, cookie } = await setup();
  const link = await call(env, '/api/cloud/link', { method: 'POST', cookie, body: { provider: 'google' } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const url = new URL(link.data.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/cloud/callback/google`);
  assert.match(url.searchParams.get('scope'), /drive\.appdata/);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(url.searchParams.get('state'));
  // Refresh tokens only arrive with offline access, and Google only reissues them
  // when consent is prompted again.
  assert.equal(url.searchParams.get('access_type'), 'offline');
  // select_account was added so a shared phone can pick the right Google account
  // instead of silently reusing the last one that consented.
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');

  // Each attempt gets its own state, so two tabs cannot overwrite each other.
  const second = await call(env, '/api/cloud/link', { method: 'POST', cookie, body: { provider: 'google' } });
  assert.notEqual(new URL(second.data.url).searchParams.get('state'), url.searchParams.get('state'));
});

test('the callback comes back to the app root, not a 404 path', async () => {
  const { env, cookie } = await setup();
  // Denied consent is the cheapest path through the callback.
  const res = await call(env, '/api/cloud/callback/google?error=access_denied', { cookie });
  assert.equal(res.status, 302);
  const back = new URL(res.location);
  assert.equal(back.pathname, '/', 'the browser would land on a path the Worker does not serve');
  assert.equal(back.searchParams.get('cloud'), 'denied');
  assert.equal(back.searchParams.get('tab'), 'settings');
});

test('a code exchange stores a sealed refresh token and the provider never sees it', async () => {
  const { db, env, cookie, userId } = await setup();
  const linked = await startConnect(env, 'google', userId, `${ORIGIN}/api/cloud/callback/google`);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-secret', expires_in: 3600, token_type: 'Bearer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const res = await call(
      env,
      `/api/cloud/callback/google?code=code-1&state=${encodeURIComponent(linked.state)}`,
      { cookie },
    );
    assert.equal(res.status, 302);
    assert.equal(new URL(res.location).searchParams.get('cloud'), 'connected');
    assert.equal(calls.length, 1);
    const sent = String(calls[0].init.body);
    assert.match(sent, /code_verifier=/, 'PKCE verifier was not sent');
    assert.match(sent, /grant_type=authorization_code/);

    const row = db.prepare(`SELECT refresh_token FROM cloud_links WHERE provider = 'google'`).get();
    assert.ok(row, 'no connection row was written');
    assert.ok(!row.refresh_token.includes('rt-secret'), 'the refresh token was stored in clear text');
  } finally {
    globalThis.fetch = realFetch;
  }

  // The state is single use: replaying it must not link again.
  const replay = await call(
    env,
    `/api/cloud/callback/google?code=code-1&state=${encodeURIComponent(linked.state)}`,
    { cookie },
  );
  assert.equal(new URL(replay.location).searchParams.get('cloud'), 'failed');
});

test('a browser with no planner session still stores the connection', async () => {
  // This is the Android case: the consent page opens in Chrome, which holds no
  // planner cookie. Requiring a session here answered 401, so the connection was
  // silently dropped and the app went on saying "Not connected". The state is the
  // credential, so the exchange must succeed without a cookie.
  const { db, env, userId } = await setup();
  const linked = await startConnect(env, 'google', userId, `${ORIGIN}/api/cloud/callback/google`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-secret', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const res = await call(
      env,
      `/api/cloud/callback/google?code=code-1&state=${encodeURIComponent(linked.state)}`,
      { origin: null, site: 'cross-site' },
    );
    assert.equal(res.status, 200, 'a session-less return was not accepted');
    assert.match(res.text, /Google Drive connected/);
    assert.match(res.text, /intent:\/\//, 'the page does not offer the app link back');
    const row = db.prepare(`SELECT user_id FROM cloud_links WHERE provider = 'google'`).get();
    assert.equal(row && row.user_id, userId, 'the connection was not stored for the account that started it');
    const audited = db.prepare(`SELECT 1 AS ok FROM audit_log WHERE action = 'backup.link'`).get();
    assert.ok(audited, 'the successful connect was not audited');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a cross-site GET navigation back from Google connects the drive', async () => {
  const { db, env, cookie, userId } = await setup();
  const linked = await startConnect(env, 'google', userId, `${ORIGIN}/api/cloud/callback/google`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-secret', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    // Exactly what Chrome sends after a redirect from accounts.google.com.
    const res = await call(
      env,
      `/api/cloud/callback/google?code=code-1&state=${encodeURIComponent(linked.state)}`,
      { cookie, origin: null, site: 'cross-site' },
    );
    assert.equal(res.status, 302, 'the provider return was refused');
    assert.equal(new URL(res.location).searchParams.get('cloud'), 'connected');
    assert.ok(db.prepare(`SELECT 1 AS ok FROM cloud_links WHERE provider = 'google'`).get());
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unknown or reused state redirects with a reason and writes nothing', async () => {
  const { db, env, cookie, userId } = await setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-secret', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const bogus = await call(env, '/api/cloud/callback/google?code=c&state=not-a-real-state', {
      cookie,
      origin: null,
      site: 'cross-site',
    });
    assert.equal(bogus.status, 302, 'the failure was a raw JSON error, not a redirect');
    assert.equal(new URL(bogus.location).searchParams.get('cloud'), 'failed');
    assert.ok(!db.prepare(`SELECT 1 AS ok FROM cloud_links`).get(), 'an invalid state wrote a connection');

    const linked = await startConnect(env, 'google', userId, `${ORIGIN}/api/cloud/callback/google`);
    const first = await call(env, `/api/cloud/callback/google?code=code-1&state=${encodeURIComponent(linked.state)}`, {
      cookie,
      origin: null,
      site: 'cross-site',
    });
    assert.equal(new URL(first.location).searchParams.get('cloud'), 'connected');

    const replay = await call(env, `/api/cloud/callback/google?code=code-1&state=${encodeURIComponent(linked.state)}`, {
      cookie,
      origin: null,
      site: 'cross-site',
    });
    assert.equal(replay.status, 302);
    assert.equal(new URL(replay.location).searchParams.get('cloud'), 'failed');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM cloud_links`).get().n, 1, 'the replay wrote a second row');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a cross-site POST is still refused, and a same-origin POST still works', async () => {
  const { env, cookie } = await setup();
  const evil = await call(env, '/api/cloud/settings', {
    method: 'POST',
    cookie,
    origin: 'https://evil.example',
    body: { frequency: 'weekly', keep: 3 },
  });
  assert.equal(evil.status, 403);
  assert.match(evil.data.error, /Cross-origin/);

  // A POST with no Origin but a cross-site fetch metadata is the same refusal.
  const noOrigin = await call(env, '/api/cloud/settings', {
    method: 'POST',
    cookie,
    origin: null,
    site: 'cross-site',
    body: { frequency: 'weekly', keep: 3 },
  });
  assert.equal(noOrigin.status, 403);

  const own = await call(env, '/api/cloud/settings', {
    method: 'POST',
    cookie,
    origin: ORIGIN,
    site: 'same-origin',
    body: { frequency: 'weekly', keep: 3 },
  });
  assert.equal(own.status, 200);
  assert.equal(own.data.settings.frequency, 'weekly');
});

test('another account cannot complete a connection with a stolen state', async () => {
  const { env, cookie } = await setup();
  const linked = await startConnect(env, 'google', 'some-other-user', `${ORIGIN}/api/cloud/callback/google`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
  try {
    const res = await call(
      env,
      `/api/cloud/callback/google?code=c&state=${encodeURIComponent(linked.state)}`,
      { cookie },
    );
    assert.equal(new URL(res.location).searchParams.get('cloud'), 'failed');
  } finally {
    globalThis.fetch = realFetch;
  }
});
