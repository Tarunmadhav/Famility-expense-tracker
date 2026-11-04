// Encrypted backups, entirely in the browser.
//
// The export JSON is sealed with AES-256-GCM under a key derived from a passphrase
// the user chooses here. The passphrase and the key never reach the server, so a
// backup stored in Google Drive or OneDrive (or just a folder) is unreadable to
// everyone except whoever knows the passphrase.

import * as api from './api.js';
import { COLLECTION_NAMES } from './entities.js';

const FORMAT = 'ffp-backup';
const VERSION = 1;
const ITERATIONS = 210000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function unb64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createBackupFile(payload, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  const envelope = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    profile: payload.profile || null,
    counts: Object.fromEntries(COLLECTION_NAMES.map((name) => [name, (payload.data?.[name] || []).length])),
    kdf: { name: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: b64(salt) },
    cipher: 'AES-GCM-256',
    iv: b64(iv),
    ciphertext: b64(ciphertext),
  };
  const text = JSON.stringify(envelope, null, 2);
  return {
    name: `planner-backup-${new Date().toISOString().slice(0, 10)}.ffpbak`,
    text,
    bytes: text.length,
    counts: envelope.counts,
  };
}

export async function readBackupFile(file, passphrase) {
  const text = await file.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('That file is not a planner backup');
  }
  if (envelope.format !== FORMAT) throw new Error('That file is not a planner backup');
  if (envelope.version > VERSION) throw new Error('This backup was made by a newer version of the app');
  if (!envelope.kdf?.salt || !envelope.iv || !envelope.ciphertext) throw new Error('This backup is incomplete');

  let key;
  try {
    key = await deriveKey(passphrase, unb64(envelope.kdf.salt), Number(envelope.kdf.iterations) || ITERATIONS);
  } catch {
    throw new Error('Could not derive the backup key');
  }
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.iv) },
      key,
      unb64(envelope.ciphertext),
    );
  } catch {
    // AES-GCM authentication failure: wrong passphrase or tampered file.
    throw new Error('Wrong passphrase, or the backup file has been altered');
  }
  let payload;
  try {
    payload = JSON.parse(dec.decode(plain));
  } catch {
    throw new Error('The decrypted backup is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.data !== 'object') {
    throw new Error('The backup does not contain planner data');
  }
  return { payload, envelope };
}

/** Restore into the profile currently selected. Rows are merged by id, never dropped first. */
export async function restorePayload(payload, onProgress = () => {}) {
  const stats = { collections: 0, added: 0, skipped: 0 };
  for (const name of COLLECTION_NAMES) {
    const rows = Array.isArray(payload.data?.[name]) ? payload.data[name] : [];
    if (!rows.length) continue;
    stats.collections += 1;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const out = await api.bulkImport(name, chunk, true);
      stats.added += Number(out?.added || 0);
      stats.skipped += Number(out?.skipped || 0);
      onProgress(stats);
    }
  }
  if (payload.settings && typeof payload.settings === 'object') {
    try {
      await api.saveSettings(payload.settings);
    } catch {
      /* settings are best effort: a viewer restoring records still gets the records */
    }
  }
  return stats;
}

export function describeBackup(envelope) {
  const counts = envelope.counts || {};
  const total = Object.values(counts).reduce((n, v) => n + Number(v || 0), 0);
  return {
    createdAt: envelope.createdAt ? new Date(envelope.createdAt) : null,
    profile: envelope.profile || null,
    total,
  };
}
