// Google Drive / OneDrive backup connector.
//
// The app cannot ship OAuth client secrets, so the owner supplies them as Worker
// secrets. Until both a client id and secret exist for a provider the endpoints
// answer 501 with a plain explanation and the UI shows "not configured" instead
// of a dead button. Tokens are encrypted with the same key as record fields and
// never returned to the browser.

import { HttpError } from './errors.js';
import { b64url, getMeta, setMeta } from './store.js';

const PROVIDERS = {
  google: {
    label: 'Google Drive',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    upload: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    clientIdKey: 'GOOGLE_CLIENT_ID',
    clientSecretKey: 'GOOGLE_CLIENT_SECRET',
  },
  onedrive: {
    label: 'OneDrive',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access Files.ReadWrite.AppFolder',
    upload: 'https://graph.microsoft.com/v1.0/me/drive/special/approot:/backup.json:/content',
    clientIdKey: 'ONEDRIVE_CLIENT_ID',
    clientSecretKey: 'ONEDRIVE_CLIENT_SECRET',
  },
};

export function providerInfo(env) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    configured: Boolean(env[p.clientIdKey] && env[p.clientSecretKey]),
  }));
}

function providerOf(env, id) {
  const provider = PROVIDERS[String(id || '')];
  if (!provider) throw new HttpError(404, 'Unknown backup provider');
  if (!env[provider.clientIdKey] || !env[provider.clientSecretKey]) {
    throw new HttpError(
      501,
      `${provider.label} is not configured. Add ${provider.clientIdKey} and ${provider.clientSecretKey} as Worker secrets.`,
    );
  }
  return provider;
}

/** PKCE verifier + challenge, and the opaque state that ties a callback to a user. */
export async function startConnect(env, providerId, userId, redirectUri) {
  const provider = providerOf(env, providerId);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await setMeta(env, `oauth:${state}`, {
    provider: providerId,
    userId,
    verifier,
    redirectUri,
    at: Date.now(),
  });
  const url = new URL(provider.authorize);
  url.searchParams.set('client_id', env[provider.clientIdKey]);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (providerId === 'google') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return { url: url.toString(), state };
}

export async function finishConnect(env, providerId, code, state) {
  const pending = await getMeta(env, `oauth:${state}`, null);
  if (!pending || pending.provider !== providerId) throw new HttpError(400, 'That sign-in link has expired');
  // A state older than ten minutes is not honoured.
  if (!pending.at || Date.now() - pending.at > 600_000) throw new HttpError(400, 'That sign-in link has expired');
  const provider = providerOf(env, providerId);
  const body = new URLSearchParams({
    client_id: env[provider.clientIdKey],
    client_secret: env[provider.clientSecretKey],
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  const res = await fetch(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new HttpError(400, 'The provider did not accept the sign-in');
  }
  await setMeta(env, `oauth:${state}`, null);
  return {
    userId: pending.userId,
    provider: providerId,
    refreshToken: data.refresh_token || '',
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

async function accessToken(env, saved) {
  if (saved.accessToken && saved.expiresAt && saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
  if (!saved.refreshToken) throw new HttpError(401, 'Reconnect your drive');
  const provider = providerOf(env, saved.provider);
  const body = new URLSearchParams({
    client_id: env[provider.clientIdKey],
    client_secret: env[provider.clientSecretKey],
    grant_type: 'refresh_token',
    refresh_token: saved.refreshToken,
  });
  const res = await fetch(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) throw new HttpError(401, 'Reconnect your drive');
  return data.access_token;
}

/**
 * Upload a JSON backup. Google uses multipart metadata+content, OneDrive takes a
 * plain PUT to the app folder.
 */
export async function uploadBackup(env, saved, filename, payload) {
  const provider = providerOf(env, saved.provider);
  const token = await accessToken(env, saved);
  const json = JSON.stringify(payload);
  if (saved.provider === 'google') {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: filename, mimeType: 'application/json' })], { type: 'application/json' }));
    form.append('file', new Blob([json], { type: 'application/json' }));
    const res = await fetch(provider.upload, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw new HttpError(502, 'Google Drive rejected the upload');
    return { ok: true, provider: 'google' };
  }
  const res = await fetch(provider.upload.replace('/backup.json', `/${filename}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: json,
  });
  if (!res.ok) throw new HttpError(502, 'OneDrive rejected the upload');
  return { ok: true, provider: 'onedrive' };
}
