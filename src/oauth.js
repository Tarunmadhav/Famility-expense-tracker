// Social sign-in (GitHub, Google, Microsoft) plus the shared authorize/callback
// plumbing. Like the drive connector this stays dormant until the owner supplies
// client credentials, so a deployment without them simply hides the buttons.

import { HttpError } from './errors.js';

export const SIGNIN_PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    idKey: 'GOOGLE_CLIENT_ID',
    secretKey: 'GOOGLE_CLIENT_SECRET',
    userinfo: {
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      email: (j) => j.email,
      name: (j) => j.name || j.email,
      id: (j) => j.sub,
    },
  },
  microsoft: {
    label: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid profile email User.Read',
    idKey: 'ONEDRIVE_CLIENT_ID',
    secretKey: 'ONEDRIVE_CLIENT_SECRET',
    userinfo: {
      url: 'https://graph.microsoft.com/v1.0/me',
      email: (j) => j.mail || j.userPrincipalName,
      name: (j) => j.displayName || j.userPrincipalName,
      id: (j) => j.id,
    },
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    idKey: 'GITHUB_CLIENT_ID',
    secretKey: 'GITHUB_CLIENT_SECRET',
    userinfo: {
      url: 'https://api.github.com/user',
      email: (j) => j.email,
      name: (j) => j.name || j.login,
      id: (j) => String(j.id),
    },
    // GitHub hides the primary address unless the scope is granted separately.
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

function providerOf(env, id) {
  const provider = SIGNIN_PROVIDERS[String(id || '')];
  if (!provider) throw new HttpError(404, 'Unknown sign-in provider');
  if (!env[provider.idKey] || !env[provider.secretKey]) {
    throw new HttpError(501, `${provider.label} sign-in is not configured (${provider.idKey}).`);
  }
  return provider;
}

export function authorizeUrl(env, providerId, { redirectUri, state }) {
  const provider = providerOf(env, providerId);
  const url = new URL(provider.authorize);
  url.searchParams.set('client_id', env[provider.idKey]);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

export async function exchangeCode(env, providerId, { code, redirectUri }) {
  const provider = providerOf(env, providerId);
  const body = new URLSearchParams({
    client_id: env[provider.idKey],
    client_secret: env[provider.secretKey],
    code: String(code),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) throw new HttpError(401, 'The provider rejected the sign-in');
  return data.access_token;
}

export async function fetchProfile(env, providerId, token) {
  const provider = providerOf(env, providerId);
  const res = await fetch(provider.userinfo.url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'family-planner' },
  });
  if (!res.ok) throw new HttpError(401, 'Could not read the account from the provider');
  const json = await res.json().catch(() => null);
  if (!json) throw new HttpError(401, 'Could not read the account from the provider');
  let email = provider.userinfo.email(json) || '';
  if (!email && provider.extraEmails) {
    const list = await fetch(provider.extraEmails, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'family-planner' },
    })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    const primary = Array.isArray(list) ? list.find((e) => e.primary && e.verified) || list.find((e) => e.verified) : null;
    email = primary ? primary.email : '';
  }
  if (!email) throw new HttpError(401, 'That account has no confirmed email address');
  return {
    email: String(email).toLowerCase(),
    name: provider.userinfo.name(json) || String(email).split('@')[0],
    providerId: String(provider.userinfo.id(json) || ''),
    provider: providerId,
  };
}
