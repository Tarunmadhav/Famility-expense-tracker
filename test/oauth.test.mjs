// Social sign-in, tested against mocked providers only here. The production path
// talks to Google/Facebook/Microsoft/GitHub; these tests exercise the parts that
// decide who the person is and which account they land in, which is where a
// mistake becomes an account takeover.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  challengeFor,
  consumeLoginTicket,
  exchangeCode,
  fetchIdentity,
  issueLoginTicket,
  startAuthorization,
} from '../src/oauth.js';
import { applyMigrations } from '../src/migrations/runner.js';
import { resolveOauthAccount, setMeta } from '../src/store.js';
import { makeDatabase } from './helpers/d1.mjs';

const ENV_KEYS = {
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  FACEBOOK_CLIENT_ID: 'facebook-id',
  FACEBOOK_CLIENT_SECRET: 'facebook-secret',
  MICROSOFT_CLIENT_ID: 'ms-id',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
};

async function freshEnv() {
  const { db, env } = makeDatabase();
  await applyMigrations(env);
  Object.assign(env, ENV_KEYS);
  return { db, env };
}

/** A stand-in for the provider, answering token and userinfo calls. */
function mockProvider({ token = 'access-token', userinfo = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? String(options.body) : null });
    if (String(url).includes('token')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ access_token: token }),
        text: async () => JSON.stringify({ access_token: token }),
      };
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => userinfo,
      text: async () => JSON.stringify(userinfo),
    };
  };
  return { fetchImpl, calls };
}

test('the PKCE challenge matches the RFC 7636 example', async () => {
  assert.equal(
    await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('the authorize URL carries state, PKCE and the exact redirect', async () => {
  const { env } = await freshEnv();
  const started = await startAuthorization(env, {
    provider: 'google',
    redirectUri: 'https://planner.example/api/auth/oauth/callback/google',
  });
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge').length >= 43);
  assert.equal(url.searchParams.get('state'), started.state);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://planner.example/api/auth/oauth/callback/google');
  // GitHub does not accept PKCE; the URL must not pretend it does.
  const gh = await startAuthorization(env, { provider: 'github', redirectUri: 'https://planner.example/cb' });
  assert.equal(new URL(gh.url).searchParams.get('code_challenge'), null);
});

test('the code exchange sends the verifier and burns the state', async () => {
  const { env } = await freshEnv();
  const started = await startAuthorization(env, { provider: 'google', redirectUri: 'https://p.example/cb' });
  const { fetchImpl, calls } = mockProvider();
  await exchangeCode(env, 'google', { code: 'abc', state: started.state, fetchImpl });
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get('code'), 'abc');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.ok(sent.get('code_verifier').length >= 43, 'code_verifier missing');

  // The same state cannot be replayed: the callback is a one-shot.
  await assert.rejects(
    () => exchangeCode(env, 'google', { code: 'abc', state: started.state, fetchImpl }),
    /expired/,
  );
});

test('a state older than ten minutes is rejected', async () => {
  const { env } = await freshEnv();
  const started = await startAuthorization(env, { provider: 'google', redirectUri: 'https://p.example/cb' });
  const pending = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`).bind(`signin:${started.state}`).first();
  const parsed = JSON.parse(pending.v);
  parsed.at = Date.now() - 11 * 60 * 1000;
  await setMeta(env, `signin:${started.state}`, parsed);
  const { fetchImpl } = mockProvider();
  await assert.rejects(
    () => exchangeCode(env, 'google', { code: 'abc', state: started.state, fetchImpl }),
    /expired/,
  );
});

test('an unconfirmed provider address can neither create nor claim an account', async () => {
  const { db, env } = await freshEnv();
  const { fetchImpl } = mockProvider({
    userinfo: { sub: 'g-1', email: 'jane@example.com', email_verified: false, name: 'Jane' },
  });
  const started = await startAuthorization(env, { provider: 'google', redirectUri: 'https://p.example/cb' });
  const { token } = await exchangeCode(env, 'google', { code: 'abc', state: started.state, fetchImpl });
  const identity = await fetchIdentity(env, 'google', token, fetchImpl);
  assert.equal(identity.emailVerified, false);
  await assert.rejects(() => resolveOauthAccount(env, identity), /confirmed email/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 0);
});

test('the same confirmed address from two providers is one account', async () => {
  const { db, env } = await freshEnv();

  const google = {
    provider: 'google',
    providerId: 'g-77',
    email: 'jane@example.com',
    emailVerified: true,
    name: 'Jane',
  };
  const first = await resolveOauthAccount(env, google);
  assert.equal(first.outcome, 'created');

  const facebook = {
    provider: 'facebook',
    providerId: 'fb-9',
    email: 'JANE@example.com',
    emailVerified: true,
    name: 'Jane G',
  };
  const second = await resolveOauthAccount(env, facebook);
  assert.equal(second.outcome, 'linked-by-email');
  assert.equal(second.user.id, first.user.id, 'the Facebook sign-in must land in the Google account');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM oauth_links`).get().n, 2);
  // Signing in again with the same provider identity reuses the link.
  const again = await resolveOauthAccount(env, google);
  assert.equal(again.outcome, 'existing-link');
  assert.equal(again.user.id, first.user.id);
});

test('an existing provider link wins over a changed address', async () => {
  const { env } = await freshEnv();
  const alice = await resolveOauthAccount(env, {
    provider: 'google',
    providerId: 'g-alice',
    email: 'alice@example.com',
    emailVerified: true,
    name: 'Alice',
  });
  const bob = await resolveOauthAccount(env, {
    provider: 'facebook',
    providerId: 'fb-bob',
    email: 'bob@example.com',
    emailVerified: true,
    name: 'Bob',
  });
  assert.notEqual(alice.user.id, bob.user.id);
  // Alice changes her Google address to Bob's. The link says this Google identity
  // is Alice, and that is what must win: an address is not an identity.
  const moved = await resolveOauthAccount(env, {
    provider: 'google',
    providerId: 'g-alice',
    email: 'bob@example.com',
    emailVerified: true,
    name: 'Alice',
  });
  assert.equal(moved.user.id, alice.user.id);
});

test('a login ticket works once and expires', async () => {
  const { env } = await freshEnv();
  await env.DB.prepare(
    `INSERT INTO users (id, name, iterations, created_at, role) VALUES ('u1', 'A', 100000, 1, 'owner')`,
  ).run();
  const ticket = await issueLoginTicket(env, 'u1');
  assert.equal(await consumeLoginTicket(env, ticket), 'u1');
  assert.equal(await consumeLoginTicket(env, ticket), null, 'a ticket must not be redeemable twice');
  assert.equal(await consumeLoginTicket(env, 'x'.repeat(40)), null);

  const stale = await issueLoginTicket(env, 'u1');
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`).bind(`ticket:${stale}`).first();
  const parsed = JSON.parse(row.v);
  parsed.at = Date.now() - 61_000;
  await setMeta(env, `ticket:${stale}`, parsed);
  assert.equal(await consumeLoginTicket(env, stale), null);
});
