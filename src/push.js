// Web Push (RFC 8030 + RFC 8291, aes128gcm) implemented with WebCrypto only,
// so it runs unchanged inside the Worker. VAPID keys are generated once and
// kept server-side in D1; the browser only ever sees the public key.

import { b64url, getMeta, unb64 } from './store.js';

const enc = new TextEncoder();

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function rawPublicKey(jwk) {
  return concat(new Uint8Array([4]), unb64Url(jwk.x), unb64Url(jwk.y));
}

function unb64Url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return unb64(s + pad);
}

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateJwk: { kty: 'EC', crv: 'P-256', d: privateJwk.d, x: privateJwk.x, y: privateJwk.y },
    publicKey: b64url(rawPublicKey(publicJwk)),
  };
}

async function vapidHeaders(env, endpoint, keys) {
  const audience = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: 'mailto:planner@example.com',
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    keys.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));
  const jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

async function encryptPayload(subscription, plaintext) {
  const uaPublic = unb64Url(subscription.p256dh);
  const authSecret = unb64Url(subscription.auth);

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256),
  );

  const ikm = await hkdf(
    authSecret,
    shared,
    concat(enc.encode('WebPush: info\u0000'), uaPublic, asPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\u0000'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      aesKey,
      concat(enc.encode(plaintext), new Uint8Array([2])),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function sendOne(env, subscription, payloadStr) {
  const keys = await getMeta(env, 'vapid', null);
  if (!keys) return { ok: false, reason: 'no_vapid' };
  const body = await encryptPayload(subscription, payloadStr);
  const authorization = await vapidHeaders(env, subscription.endpoint, keys);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(subscription.endpoint).run();
    return { ok: false, reason: 'gone', status: res.status };
  }
  return { ok: res.ok, status: res.status };
}

/** Push every fresh notification to every subscribed device. */
export async function sendPushToAll(env, notifications) {
  if (!notifications || !notifications.length) return { sent: 0, failed: 0 };
  const res = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subs`).all();
  const subs = res.results || [];
  if (!subs.length) return { sent: 0, failed: 0, reason: 'no_subscribers' };
  let sent = 0;
  let failed = 0;
  for (const note of notifications) {
    const payload = JSON.stringify({
      title: note.title,
      body: note.body,
      tag: note.type,
      level: note.level,
      url: '/',
    });
    for (const sub of subs) {
      try {
        const out = await sendOne(env, sub, payload);
        if (out.ok) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { sent, failed };
}

export async function sendTestPush(env) {
  const keys = await getMeta(env, 'vapid', null);
  if (!keys) return { sent: 0, failed: 0, reason: 'no_vapid' };
  const res = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subs`).all();
  const subs = res.results || [];
  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      const out = await sendOne(
        env,
        sub,
        JSON.stringify({
          title: 'Notifications are on',
          body: 'Family Finance Planner will alert you about bills, renewals, tasks and birthdays.',
          tag: 'test',
          url: '/',
        }),
      );
      if (out.ok) sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed, subscribers: subs.length };
}

export async function saveSubscription(env, sub, ua) {
  const endpoint = String(sub.endpoint || '').slice(0, 500);
  if (!/^https:\/\//.test(endpoint)) return false;
  await env.DB.prepare(
    `INSERT INTO push_subs (id, endpoint, p256dh, auth, created_at, ua) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(
      crypto.randomUUID(),
      endpoint,
      String(sub.keys?.p256dh || '').slice(0, 200),
      String(sub.keys?.auth || '').slice(0, 100),
      Date.now(),
      (ua || '').slice(0, 180),
    )
    .run();
  return true;
}

export async function removeSubscription(env, endpoint) {
  await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(String(endpoint || '').slice(0, 500)).run();
}
