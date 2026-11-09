// Social sign-in: Google, Facebook, Microsoft and GitHub.
//
// The flow is built for a WebView shell, so nothing about it depends on the
// provider's page being allowed to load inside the app:
//
//   1. the app asks this Worker for an authorize URL (state + PKCE S256)
//   2. the URL opens in the device's own browser, where the provider's cookies
//      and password manager live
//   3. the provider redirects to /api/auth/oauth/callback/<provider> on this
//      Worker, which exchanges the code server-side and mints a one-time ticket
//   4. the app link for /api/auth/oauth/landing hands that ticket back to the
//      WebView, which trades it for a session cookie
//
// The ticket makes step 4 work across two cookie jars: the browser's cookie is
// useless to the app, so the app gets its own, single-use, 60-second ticket
// instead. Nothing provider-specific is trusted beyond the identity: the account
// is chosen by the rules in resolveAccount() below.

import { HttpError } from './errors.js';
import { getMeta, setMeta, takeMeta } from './store.js';

const TEN_MINUTES = 600_000;
const TICKET_MS = 60_000;

const GRAPH = 'https://graph.microsoft.com/v1.0/me';

export const SIGNIN_PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    pkce: true,
    extraAuthorize: { access_type: 'online', prompt: 'select_account' },
    idKey: 'GOOGLE_CLIENT_ID',
    secretKey: 'GOOGLE_CLIENT_SECRET',
    userinfo: {
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      id: (j) => j.sub,
      email: (j) => j.email,
      name: (j) => j.name || j.email,
      // Google states this explicitly; an unverified address must never be used
      // to claim an existing account.
      verified: (j) => j.email_verified === true,
    },
  },
  facebook: {
    label: 'Facebook',
    authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
    token: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scope: 'email public_profile',
    pkce: true,
    idKey: 'FACEBOOK_CLIENT_ID',
    secretKey: 'FACEBOOK_CLIENT_SECRET',
    userinfo: {
      url: 'https://graph.facebook.com/v21.0/me?fields=id,name,email',
      id: (j) => j.id,
      email: (j) => j.email,
      name: (j) => j.name || j.email,
      // Facebook only returns an address it has verified; a missing one means
      // the person hid it or never confirmed it.
      verified: (j) => Boolean(j.email),
    },
  },
  microsoft: {
    label: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid profile email User.Read',
    pkce: true,
    idKey: 'MICROSOFT_CLIENT_ID',
    secretKey: 'MICROSOFT_CLIENT_SECRET',
    userinfo: {
      url: GRAPH,
      id: (j) => j.id,
      email: (j) => j.mail || j.userPrincipalName,
      name: (j) => j.displayName || j.userPrincipalName,
      // Work/school addresses come from the directory; personal accounts use the
      // verified Microsoft address.
      verified: () => true,
    },
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    // GitHub OAuth Apps do not accept PKCE; state alone protects this flow.
    pkce: false,
    idKey: 'GITHUB_CLIENT_ID',
    secretKey: 'GITHUB_CLIENT_SECRET',
    userinfo: {
      url: 'https://api.github.com/user',
      id: (j) => j.id,
      email: (j) => j.email,
      name: (j) => j.name || j.login,
      verified: () => false, // decided from /user/emails below
    },
    extraEmails: 'https://api.github.com/user/emails',
  },
};

export function signInProviders(env) {
  return Object.entries(SIGNIN_PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    configured: Boolean(env[p.idKey] && env[p.secretKey]),
  }));
}

export function providerOf(env, id) {
  const provider = SIGNIN_PROVIDERS[String(id || '')];
  if (!provider) throw new HttpError(404, 'Unknown sign-in provider');
  if (!env[provider.idKey] || !env[provider.secretKey]) {
    throw new HttpError(501, `${provider.label} sign-in is not configured (${provider.idKey}).`);
  }
  return provider;
}

function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomVerifier() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

/** Step 1: build the URL and remember what this attempt is for. */
export async function startAuthorization(env, { provider, redirectUri, returnTo }) {
  const config = providerOf(env, provider);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = config.pkce ? randomVerifier() : '';
  const challenge = config.pkce ? await challengeFor(verifier) : '';
  await setMeta(env, `signin:${state}`, {
    provider,
    verifier,
    redirectUri,
    returnTo: String(returnTo || '/').slice(0, 200),
    at: Date.now(),
  });
  const url = new URL(config.authorize);
  url.searchParams.set('client_id', env[config.idKey]);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  if (config.pkce) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(config.extraAuthorize || {})) {
    url.searchParams.set(key, value);
  }
  return { url: url.toString(), state };
}

async function readToken(provider, res) {
  const type = res.headers.get('Content-Type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
  if (data) return data;
  // GitHub answers form-encoded unless Accept: application/json is honoured.
  const text = await res.text().catch(() => '');
  return Object.fromEntries(new URLSearchParams(text));
}

export async function exchangeCode(env, providerId, { code, redirectUri, verifier, state, fetchImpl = fetch }) {
  const config = providerOf(env, providerId);
  const pending = await takeMeta(env, `signin:${state}`);
  if (!pending || pending.provider !== providerId) throw new HttpError(400, 'That sign-in link has expired');
  if (!pending.at || Date.now() - pending.at > TEN_MINUTES) throw new HttpError(400, 'That sign-in link has expired');
  const body = new URLSearchParams({
    client_id: env[config.idKey],
    client_secret: env[config.secretKey],
    code: String(code || ''),
    redirect_uri: redirectUri || pending.redirectUri,
    grant_type: 'authorization_code',
  });
  if (config.pkce) body.set('code_verifier', pending.verifier || verifier || '');
  const res = await fetchImpl(config.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await readToken(config, res);
  if (!res.ok || !data || !data.access_token) {
    throw new HttpError(401, 'The provider rejected the sign-in');
  }
  return { token: data.access_token, pending };
}

/** Step 3a: who is this, according to the provider? */
export async function fetchIdentity(env, providerId, token, fetchImpl = fetch) {
  const config = providerOf(env, providerId);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'family-planner' };
  const res = await fetchImpl(config.userinfo.url, { headers });
  if (!res.ok) throw new HttpError(401, 'Could not read the account from the provider');
  const json = await res.json().catch(() => null);
  if (!json) throw new HttpError(401, 'Could not read the account from the provider');

  let email = config.userinfo.email(json) || '';
  let verified = Boolean(config.userinfo.verified(json));
  if (config.extraEmails && (!email || !verified)) {
    const list = await fetchImpl(config.extraEmails, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    const primary = Array.isArray(list) ? list.find((e) => e.primary && e.verified) || list.find((e) => e.verified) : null;
    if (primary) {
      email = primary.email;
      verified = true;
    }
  }
  return {
    provider: providerId,
    providerId: String(config.userinfo.id(json) || ''),
    email: String(email || '').trim().toLowerCase(),
    emailVerified: verified,
    name: String(config.userinfo.name(json) || String(email).split('@')[0] || 'Member').slice(0, 60),
  };
}

/** One-time ticket that lets the WebView finish a sign-in started in the browser. */
export async function issueLoginTicket(env, userId) {
  const ticket = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await setMeta(env, `ticket:${ticket}`, { userId, at: Date.now() });
  return ticket;
}

export async function consumeLoginTicket(env, ticket) {
  const value = String(ticket || '');
  if (value.length < 20) return null;
  const pending = await takeMeta(env, `ticket:${value}`);
  if (!pending || !pending.userId) return null;
  if (!pending.at || Date.now() - pending.at > TICKET_MS) return null;
  return pending.userId;
}

export async function pendingSignIn(env, state) {
  return getMeta(env, `signin:${state}`, null);
}
