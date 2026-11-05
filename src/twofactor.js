// TOTP (RFC 6238) and one-time recovery codes.
//
// Both are verified on the server with WebCrypto only: no dependency, no secret
// ever leaves the Worker except the provisioning URI the user scans once. A code
// that has already been accepted cannot be replayed because the accepted time
// step is stored alongside the secret.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
// One step of clock skew in each direction, which is what authenticator apps
// themselves tolerate.
const WINDOW = 1;

export function randomBase32(bytes = 20) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decodeBase32(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function currentStep(at = Date.now()) {
  return Math.floor(at / (STEP_SECONDS * 1000));
}

async function codeForStep(secret, step) {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  view.setUint32(0, Math.floor(step / 4294967296));
  view.setUint32(4, step >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Returns the time step the code belongs to, or 0 when it does not match.
 * `lastStep` blocks replay of a code that was already used.
 */
export async function matchTotp(secret, code, lastStep = 0) {
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length !== DIGITS || !secret) return 0;
  const now = currentStep();
  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const step = now + drift;
    if (step <= lastStep) continue;
    if ((await codeForStep(secret, step)) === digits) return step;
  }
  return 0;
}

/** The URI an authenticator app scans; `issuer` keeps entries distinguishable. */
export function otpauthUri({ secret, account, issuer = 'Family Finance Planner' }) {
  const label = encodeURIComponent(`${issuer}:${account || 'account'}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Human-readable recovery code: 4 groups of 4 base32 characters. */
export function newRecoveryCode() {
  const raw = randomBase32(10).slice(0, 16).padEnd(16, 'A');
  return raw.match(/.{4}/g).join('-');
}

export function normaliseRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, 20);
}
