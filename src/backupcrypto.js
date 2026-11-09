// Envelope encryption for the OAuth refresh tokens that keep a cloud drive
// connected.
//
// A refresh token is a long-lived key to somebody's Google Drive or OneDrive, so
// it must not sit in D1 as plain text: a database dump, a support export or a SQL
// injection would otherwise hand over the drive. It is sealed with AES-256-GCM
// under a key that lives in a Worker secret (`BACKUP_KEY`, base64, 32 bytes), and
// the D1 row only ever holds ciphertext.
//
// The value is versioned so the key can be rotated: `v1.<iv>.<ciphertext>`.

const PREFIX = 'v1';
const AAD = new TextEncoder().encode('ffp-cloud-refresh-token');

function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '==='.slice((padded.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function backupKeyConfigured(env) {
  return Boolean(env && env.BACKUP_KEY);
}

async function importKey(env) {
  const raw = unb64url(String(env.BACKUP_KEY || ''));
  if (raw.length !== 32) {
    throw new Error('BACKUP_KEY must be 32 bytes, base64url encoded (openssl rand -base64 32)');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealToken(env, plaintext) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    key,
    new TextEncoder().encode(String(plaintext)),
  );
  return `${PREFIX}.${b64url(iv)}.${b64url(ciphertext)}`;
}

export async function openToken(env, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('stored token is not in a known format');
  const key = await importKey(env);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64url(parts[1]), additionalData: AAD },
      key,
      unb64url(parts[2]),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong key (rotated without re-encrypting) or a tampered row: either way the
    // connection has to be re-established, never silently used.
    throw new Error('stored token could not be decrypted; reconnect the drive');
  }
}
