// Google Drive connector.
//
// The scope is the narrowest one that still allows a private file: Google's
// `drive.appdata` (an app folder the user cannot even see in the Drive UI). The
// app never asks for access to the rest of the drive, so a stolen token cannot
// read anything else.
//
// A connection is: PKCE + state against the provider, a refresh token sealed by
// src/backupcrypto.js before it reaches D1, and a short-lived access token that is
// refreshed on demand. Credentials are Worker secrets; without them the endpoints
// answer 501 and the UI shows the provider as not configured instead of a button
// that cannot work.

import { HttpError } from './errors.js';
import { openToken, sealToken } from './backupcrypto.js';
import { b64url, getMeta, setMeta } from './store.js';

export const CLOUD_PROVIDERS = {
  google: {
    label: 'Google Drive',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/drive.appdata',
    clientIdKey: 'GOOGLE_CLIENT_ID',
    clientSecretKey: 'GOOGLE_CLIENT_SECRET',
    extraAuthorize: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
};

export function providerInfo(env) {
  return Object.entries(CLOUD_PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    configured: Boolean(env[p.clientIdKey] && env[p.clientSecretKey]),
    // Names only, never values: the card names exactly what the owner must add.
    missing: [p.clientIdKey, p.clientSecretKey].filter((key) => !env[key]),
    scope: p.scope,
  }));
}

export function cloudProviderOf(env, id) {
  const provider = CLOUD_PROVIDERS[String(id || '')];
  if (!provider) throw new HttpError(404, 'Unknown backup provider');
  if (!env[provider.clientIdKey] || !env[provider.clientSecretKey]) {
    throw new HttpError(
      501,
      `${provider.label} is not configured. Add ${provider.clientIdKey} and ${provider.clientSecretKey} as Worker secrets.`,
    );
  }
  return provider;
}

/** Step 1: PKCE verifier + state, tied to the signed-in account. */
export async function startConnect(env, providerId, userId, redirectUri) {
  const provider = cloudProviderOf(env, providerId);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await setMeta(env, `cloudstate:${state}`, {
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
  for (const [key, value] of Object.entries(provider.extraAuthorize || {})) {
    url.searchParams.set(key, value);
  }
  return { url: url.toString(), state };
}

/** Step 2: exchange the code, seal the refresh token, drop the state. */
export async function finishConnect(env, providerId, code, state, fetchImpl = fetch) {
  const pending = await getMeta(env, `cloudstate:${state}`, null);
  if (!pending || pending.provider !== providerId) throw new HttpError(400, 'That connection link has expired');
  if (!pending.at || Date.now() - pending.at > 600_000) throw new HttpError(400, 'That connection link has expired');
  const provider = cloudProviderOf(env, providerId);
  const body = new URLSearchParams({
    client_id: env[provider.clientIdKey],
    client_secret: env[provider.clientSecretKey],
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  const res = await fetchImpl(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) throw new HttpError(400, 'The provider did not accept the connection');
  if (!data.refresh_token) {
    throw new HttpError(400, 'The provider did not return a refresh token. Remove the app from the provider account and connect again.');
  }
  await setMeta(env, `cloudstate:${state}`, null);
  return {
    userId: pending.userId,
    provider: providerId,
    sealedRefresh: await sealToken(env, data.refresh_token),
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

async function accessToken(env, saved, fetchImpl) {
  if (saved.accessToken && saved.expiresAt && Number(saved.expiresAt) > Date.now() + 60_000) {
    return saved.accessToken;
  }
  if (!saved.sealedRefresh) throw new HttpError(400, 'Reconnect that drive: no refresh token was stored.');
  const provider = cloudProviderOf(env, saved.provider);
  const refresh = await openToken(env, saved.sealedRefresh);
  const body = new URLSearchParams({
    client_id: env[provider.clientIdKey],
    client_secret: env[provider.clientSecretKey],
    grant_type: 'refresh_token',
    refresh_token: refresh,
  });
  const res = await fetchImpl(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new HttpError(401, 'The drive connection expired. Reconnect it in Settings.');
  }
  return data.access_token;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** Upload one JSON file into the account's private app folder. */
export async function uploadBackup(env, saved, filename, text, fetchImpl = fetch) {
  cloudProviderOf(env, saved.provider);
  const token = await accessToken(env, saved, fetchImpl);
  // Drive's multipart upload is multipart/related, which FormData cannot produce.
  const boundary = `ffp${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  const meta = JSON.stringify({ name: filename, mimeType: 'application/json', parents: ['appDataFolder'] });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n` +
    `--${boundary}--`;
  const res = await fetchImpl(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new HttpError(502, 'Google Drive rejected the upload');
  return { ok: true, provider: 'google', id: data.id || '', filename };
}

/** The backups currently in the app folder, newest first. */
export async function listBackups(env, saved, fetchImpl = fetch) {
  cloudProviderOf(env, saved.provider);
  const token = await accessToken(env, saved, fetchImpl);
  const query = encodeURIComponent("name contains 'family-planner-' and trashed = false");
  const res = await fetchImpl(
    `${DRIVE_API}/files?spaces=appdata&q=${query}&fields=files(id,name,createdTime,size)&orderBy=createdTime desc&pageSize=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new HttpError(502, 'Google Drive could not be listed');
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    createdAt: Date.parse(f.createdTime) || 0,
    bytes: Number(f.size) || 0,
  }));
}

export async function downloadBackup(env, saved, fileId, fetchImpl = fetch) {
  cloudProviderOf(env, saved.provider);
  const token = await accessToken(env, saved, fetchImpl);
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new HttpError(502, 'That backup could not be downloaded');
  return res.text();
}

export async function deleteBackup(env, saved, fileId, fetchImpl = fetch) {
  cloudProviderOf(env, saved.provider);
  const token = await accessToken(env, saved, fetchImpl);
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}`;
  const res = await fetchImpl(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  // 404 means it is already gone, which is the outcome the caller wanted.
  if (!res.ok && res.status !== 404) throw new HttpError(502, 'That backup could not be removed');
  return { ok: true };
}
