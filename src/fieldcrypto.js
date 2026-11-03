// Field-level encryption for sensitive values (phone numbers, emails, notes).
// AES-256-GCM with a key kept in the Worker secret FIELD_KEY (base64, 32 bytes).
// Values are stored as `enc1:<iv b64>:<ciphertext b64>`; plaintext rows written
// before the key existed still read fine, so enabling this is non-destructive.

const enc = new TextEncoder();
const dec = new TextDecoder();
const PREFIX = 'enc1:';

/** Only these fields are encrypted; everything else stays queryable. */
export const SECRET_FIELDS = {
  contacts: ['mobile', 'alt', 'email', 'remarks'],
  family: ['mobile', 'alt', 'email', 'notes'],
  payments: ['phone', 'alert', 'remarks'],
  insurance: ['phone', 'alert', 'advisor', 'remarks'],
  expenses: ['phone', 'remarks'],
  diary: ['phone', 'notes', 'remarks'],
  loans: ['phone', 'officer', 'remarks'],
  subscriptions: ['account', 'notes'],
};

let cached = null;
let cachedRaw = '';

async function keyFrom(env) {
  const raw = String((env && env.FIELD_KEY) || '').trim();
  if (!raw) return null;
  if (cached && cachedRaw === raw) return cached;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  cached = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  cachedRaw = raw;
  return cached;
}

export async function encryptionReady(env) {
  return Boolean(await keyFrom(env));
}

async function seal(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  const b64 = (bytes) => {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
    return btoa(s);
  };
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

async function open(key, value) {
  const [, ivB64, ctB64] = value.split(':');
  if (!ivB64 || !ctB64) return value;
  const bin = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bin(ivB64) }, key, bin(ctB64));
  return dec.decode(plain);
}

export async function protectDoc(env, collection, doc) {
  const key = await keyFrom(env);
  const fields = SECRET_FIELDS[collection];
  if (!key || !fields) return doc;
  const out = { ...doc };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value && !value.startsWith(PREFIX)) {
      out[field] = await seal(key, value);
    }
  }
  return out;
}

export async function revealDoc(env, collection, doc) {
  const key = await keyFrom(env);
  const fields = SECRET_FIELDS[collection];
  if (!fields) return doc;
  const out = { ...doc };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value.startsWith(PREFIX)) {
      if (!key) {
        out[field] = '';
        continue;
      }
      try {
        out[field] = await open(key, value);
      } catch {
        out[field] = '';
      }
    }
  }
  return out;
}
