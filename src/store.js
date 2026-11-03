// Data + auth layer. Everything here runs on the Worker and talks to D1 with
// bound parameters only - no string interpolation of user input ever reaches SQL.

import { COLLECTIONS, COLLECTION_NAMES, sanitizeDoc } from '../web/src/entities.js';
import { SEED, SETTINGS } from './seed.js';
import { generateVapidKeys, sendPushToAll } from './push.js';
import { protectDoc, revealDoc, encryptionReady } from './fieldcrypto.js';

export const SCHEMA_VERSION = '6';
// 100 000 is the maximum iteration count the production Workers runtime supports
// for PBKDF2-SHA256; attempts are additionally rate limited (8 per 15 minutes per IP).
const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 30;
const SWEEP_INTERVAL_MS = 60 * 1000;
const CHANGE_RETENTION_DAYS = 30;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, iterations INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ua TEXT, ip TEXT)`,
  `CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL DEFAULT 'family', collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (space, collection, id))`,
  `CREATE INDEX IF NOT EXISTS records_rev_idx ON records (space, rev)`,
  `CREATE INDEX IF NOT EXISTS records_collection_idx ON records (space, collection)`,
  `CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL DEFAULT 'family', collection TEXT NOT NULL, record_id TEXT NOT NULL, op TEXT NOT NULL, actor TEXT, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS changes_space_idx ON changes (space, seq)`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, space TEXT NOT NULL DEFAULT 'family', type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', collection TEXT, record_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER, dedupe TEXT UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (space, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS push_subs (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL, ua TEXT)`,
  `CREATE TABLE IF NOT EXISTS auth_fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS auth_fails_idx ON auth_fails (ip, ts)`,
  `CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, password_salt TEXT, iterations INTEGER, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, space TEXT NOT NULL DEFAULT 'family', name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, key TEXT UNIQUE NOT NULL, collection TEXT, record_id TEXT, uploaded_by TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS files_created_idx ON files (space, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ai_connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS family_invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER)`,
];

let schemaReady = false;

async function hasColumn(env, table, column) {
  try {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return (info.results || []).some((c) => c.name === column);
  } catch {
    return false;
  }
}

/** Adds the space column everywhere and rebuilds records' primary key, keeping every row. */
async function migrateV6(env) {
  if (!(await hasColumn(env, 'users', 'role'))) {
    try {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`).run();
    } catch {
      /* nothing to migrate */
    }
    await env.DB.prepare(
      `UPDATE users SET role = 'owner' WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1)`,
    ).run();
  }
}

async function migrateSpaces(env) {
  if (!(await hasColumn(env, 'records', 'space'))) {
    const legacy = await hasColumn(env, 'records', 'doc');
    if (legacy) await env.DB.prepare(`ALTER TABLE records RENAME TO records_legacy`).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL DEFAULT 'family', collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (space, collection, id))`,
    ).run();
    if (legacy) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO records (space, collection, id, doc, rev, updated_at, updated_by)
         SELECT 'family', collection, id, doc, rev, updated_at, updated_by FROM records_legacy`,
      ).run();
      // Keep the pre-v5 table as a local rollback copy instead of dropping it.
      await env.DB.prepare(`DROP TABLE IF EXISTS records_backup_v4`).run();
      await env.DB.prepare(`ALTER TABLE records_legacy RENAME TO records_backup_v4`).run();
    }
  }
  for (const table of ['changes', 'notifications', 'files']) {
    if (!(await hasColumn(env, table, 'space'))) {
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN space TEXT NOT NULL DEFAULT 'family'`).run();
      } catch {
        /* table not created yet; STATEMENTS below will create it with the column */
      }
    }
  }
}

export async function ensureSchema(env) {
  if (schemaReady) return;
  let current = null;
  try {
    const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first();
    current = row ? row.v : null;
  } catch {
    current = null;
  }
  if (current === SCHEMA_VERSION) {
    schemaReady = true;
    return;
  }
  // v5 adds personal/family spaces. The migration is additive: existing rows are
  // kept and assigned to the family book, so deploying never destroys user data.
  await migrateSpaces(env);
  for (const sql of STATEMENTS) await env.DB.prepare(sql).run();
  await migrateV6(env);
  await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  )
    .bind(SCHEMA_VERSION)
    .run();
  schemaReady = true;
}

/* ------------------------------------------------------------------ meta */

export async function getMeta(env, key, fallback = null) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`).bind(key).first();
  if (!row) return fallback;
  try {
    return JSON.parse(row.v);
  } catch {
    return row.v;
  }
}

export async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  )
    .bind(key, JSON.stringify(value))
    .run();
}

/* -------------------------------------------------------------- encoding */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomToken(bytes = 32) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(arr);
}

/* ----------------------------------------------------------------- users */

async function derivePin(pin, saltB64, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations },
    key,
    256,
  );
  return b64(new Uint8Array(bits));
}

function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function countUsers(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  return row ? row.n : 0;
}

export async function createUser(env, name, pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(pin, salt, PBKDF2_ITERATIONS);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, name, pin_hash, pin_salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, String(name).trim().slice(0, 60) || 'Family', hash, salt, PBKDF2_ITERATIONS, Date.now())
    .run();
  return { id, name };
}

export async function verifyPin(env, pin) {
  const user = await env.DB.prepare(`SELECT * FROM users WHERE length(pin_hash) > 0 ORDER BY created_at LIMIT 1`).first();
  if (!user) return null;
  const candidate = await derivePin(pin, user.pin_salt, user.iterations);
  return timingSafeEqual(candidate, user.pin_hash) ? { id: user.id, name: user.name } : null;
}

/* --------------------------------------------- email + password accounts */

const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;

export function isStrongPassword(password) {
  return PASSWORD_RE.test(String(password || ''));
}

export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 160);
}

export async function emailTaken(env, email) {
  const row = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`)
    .bind(normaliseEmail(email))
    .first();
  return Boolean(row);
}

export function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normaliseEmail(email));
}

/** Creates a member account that signs in with email + password (no PIN). */
export async function createEmailUser(env, email, password, name) {
  const clean = normaliseEmail(email);
  const existing = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`).bind(clean).first();
  if (existing) throw new HttpError(409, 'That email already has an account');
  const userId = crypto.randomUUID();
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(password, salt, PBKDF2_ITERATIONS);
  const displayName = String(name || clean.split('@')[0]).trim().slice(0, 60) || 'Member';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, name, pin_hash, pin_salt, iterations, created_at) VALUES (?, ?, '', '', ?, ?)`,
    ).bind(userId, displayName, PBKDF2_ITERATIONS, Date.now()),
    env.DB.prepare(
      `INSERT INTO credentials (user_id, email, password_hash, password_salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(userId, clean, hash, salt, PBKDF2_ITERATIONS, Date.now()),
  ]);
  return { id: userId, name: displayName, email: clean };
}

export async function verifyPassword(env, email, password) {
  const clean = normaliseEmail(email);
  const row = await env.DB.prepare(
    `SELECT c.password_hash, c.password_salt, c.iterations, u.id, u.name FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.email = ?`,
  )
    .bind(clean)
    .first();
  if (!row) return null;
  const candidate = await derivePin(String(password || ''), row.password_salt, row.iterations);
  return timingSafeEqual(candidate, row.password_hash) ? { id: row.id, name: row.name, email: clean } : null;
}

/** Set or replace the password for a user (used by signup-owner and change-password). */
export async function setPassword(env, userId, email, password) {
  const clean = normaliseEmail(email);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(password, salt, PBKDF2_ITERATIONS);
  await env.DB.prepare(
    `INSERT INTO credentials (user_id, email, password_hash, password_salt, iterations, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
       password_salt = excluded.password_salt, iterations = excluded.iterations`,
  )
    .bind(userId, clean, hash, salt, PBKDF2_ITERATIONS, Date.now())
    .run();
}

export async function credentialsFor(env, userId) {
  return env.DB.prepare(`SELECT email FROM credentials WHERE user_id = ?`).bind(userId).first();
}

/* ------------------------------------------------- family membership */

export async function listMembers(env) {
  const res = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.created_at, c.email
       FROM users u LEFT JOIN credentials c ON c.user_id = u.id ORDER BY u.created_at`,
  ).all();
  return res.results || [];
}

export async function memberRole(env, userId) {
  const row = await env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(userId).first();
  return row ? row.role : null;
}

export async function createInvite(env, userId) {
  const code = randomToken(9).replace(/[-_]/g, '').slice(0, 10).toUpperCase();
  const expiresAt = Date.now() + 72 * 3600000;
  await env.DB.prepare(
    `INSERT INTO family_invites (code, created_by, role, expires_at) VALUES (?, ?, 'member', ?)`,
  )
    .bind(code, userId, expiresAt)
    .run();
  return { code, expiresAt };
}

export async function checkInvite(env, code) {
  const clean = String(code || '').trim().toUpperCase().slice(0, 12);
  if (!clean) return null;
  const row = await env.DB.prepare(`SELECT * FROM family_invites WHERE code = ?`).bind(clean).first();
  if (!row || row.used_by || row.expires_at < Date.now()) return null;
  return row;
}

export async function redeemInvite(env, code, userId) {
  await env.DB.prepare(`UPDATE family_invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`)
    .bind(userId, Date.now(), String(code).toUpperCase())
    .run();
}

/** Removing a member also deletes their personal and office books and their sessions. */
export async function removeMember(env, userId) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM credentials WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM records WHERE space = ?`).bind(`u:${userId}`),
    env.DB.prepare(`DELETE FROM records WHERE space = ?`).bind(`o:${userId}`),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId),
  ]);
}

/* ---------------------------------------------------------------- files */

export async function listFiles(env, space, limit = 60) {
  const res = await env.DB.prepare(
    `SELECT id, name, mime, size, collection, record_id, created_at FROM files WHERE space = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(space, limit)
    .all();
  const rows = res.results || [];
  const total = rows.reduce((sum, f) => sum + Number(f.size || 0), 0);
  return { files: rows, totalBytes: total };
}

export async function getFile(env, id) {
  return env.DB.prepare(`SELECT * FROM files WHERE id = ?`).bind(String(id)).first();
}

export async function insertFile(env, file) {
  await env.DB.prepare(
    `INSERT INTO files (id, space, name, mime, size, key, collection, record_id, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      file.id,
      file.space || 'family',
      file.name,
      file.mime,
      file.size,
      file.key,
      file.collection || null,
      file.recordId || null,
      file.uploadedBy || null,
      Date.now(),
    )
    .run();
  return file;
}

export async function deleteFileRow(env, id) {
  await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(String(id)).run();
}

/* ------------------------------------------------------ AI connections */

export async function listAiConnections(env) {
  const res = await env.DB.prepare(`SELECT id, provider, base_url, model, created_at FROM ai_connections ORDER BY created_at`).all();
  return res.results || [];
}

export async function addAiConnection(env, input, userId) {
  const provider = String(input.provider || '').trim().slice(0, 40) || 'Custom';
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '').slice(0, 200);
  const model = String(input.model || '').trim().slice(0, 80);
  const apiKey = String(input.apiKey || '').trim().slice(0, 400);
  if (!/^https:\/\/[^\s]+$/.test(baseUrl)) throw new HttpError(400, 'Base URL must start with https://');
  if (/^https:\/\/(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/i.test(baseUrl)) throw new HttpError(400, 'Private addresses are not allowed');
  if (!model) throw new HttpError(400, 'Model name is required');
  if (apiKey.length < 8) throw new HttpError(400, 'API key looks too short');
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO ai_connections (id, provider, base_url, model, api_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, provider, baseUrl, model, apiKey, userId || null, Date.now())
    .run();
  return { id, provider, base_url: baseUrl, model };
}

export async function deleteAiConnection(env, id) {
  await env.DB.prepare(`DELETE FROM ai_connections WHERE id = ?`).bind(String(id)).run();
}

export async function activeAiConnection(env) {
  return env.DB.prepare(`SELECT * FROM ai_connections ORDER BY created_at DESC LIMIT 1`).first();
}

export async function createSession(env, userId, request) {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, ua, ip) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      now,
      now + SESSION_DAYS * 86400000,
      (request.headers.get('User-Agent') || '').slice(0, 180),
      clientIp(request),
    )
    .run();
  return token;
}

export async function getSession(env, token) {
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id, s.expires_at, u.id AS user_id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
    return null;
  }
  return { sessionId: row.id, userId: row.user_id, name: row.name };
}

export async function deleteSession(env, token) {
  if (!token) return;
  const id = await sha256Hex(token);
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
}

export async function deleteUserSessions(env, userId, keepSessionId) {
  if (keepSessionId) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`).bind(userId, keepSessionId).run();
  } else {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  }
}

export async function updatePin(env, pin) {
  const user = await env.DB.prepare(`SELECT id FROM users ORDER BY created_at LIMIT 1`).first();
  if (!user) return null;
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(pin, salt, PBKDF2_ITERATIONS);
  await env.DB.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ?, iterations = ? WHERE id = ?`)
    .bind(hash, salt, PBKDF2_ITERATIONS, user.id)
    .run();
  return user.id;
}

export async function listSessions(env, userId) {
  const res = await env.DB.prepare(
    `SELECT id, created_at, expires_at, ua FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return res.results || [];
}

/* ---------------------------------------------------------- login limits */

export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'local'
  ).slice(0, 60);
}

export async function recordAuthFailure(env, ip) {
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM auth_fails WHERE ts < ?`).bind(now - 86400000).run();
  await env.DB.prepare(`INSERT INTO auth_fails (ip, ts) VALUES (?, ?)`).bind(ip, now).run();
}

export async function isLockedOut(env, ip) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_fails WHERE ip = ? AND ts > ?`)
    .bind(ip, Date.now() - 15 * 60000)
    .first();
  return (row ? row.n : 0) >= 8;
}

export async function clearAuthFailures(env, ip) {
  await env.DB.prepare(`DELETE FROM auth_fails WHERE ip = ?`).bind(ip).run();
}

/* --------------------------------------------------------------- records */

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysTo(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const target = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${istToday()}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}

export async function nextContactId(env, space = 'family') {
  const row = await env.DB.prepare(
    `SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS n FROM records WHERE space = ? AND collection = 'contacts' AND id LIKE 'CNT-%'`,
  )
    .bind(space)
    .first();
  const next = (row && row.n ? row.n : 0) + 1;
  return `CNT-${String(next).padStart(4, '0')}`;
}

async function logChange(env, space, collection, recordId, op, actor) {
  const res = await env.DB.prepare(
    `INSERT INTO changes (space, collection, record_id, op, actor, ts) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(space, collection, recordId, op, actor || 'system', Date.now())
    .run();
  return (res.meta && res.meta.last_row_id) || 0;
}

export async function listCollection(env, space, collection) {
  const res = await env.DB.prepare(
    `SELECT id, doc FROM records WHERE space = ? AND collection = ? ORDER BY id`,
  )
    .bind(space, collection)
    .all();
  const rows = [];
  for (const r of res.results || []) {
    rows.push({ ...(await revealDoc(env, collection, JSON.parse(r.doc))), id: r.id });
  }
  return rows;
}

export async function createRecord(env, space, collection, input, actor) {
  const def = COLLECTIONS[collection];
  if (!def) throw new HttpError(400, 'Unknown collection');
  const doc = sanitizeDoc(collection, input);
  let id = String((input && input.id) || '');
  if (def.autoId) {
    id = await nextContactId(env, space);
    doc.id = id;
  } else {
    id = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : crypto.randomUUID();
  }
  const stored = await protectDoc(env, collection, doc);
  const rev = await logChange(env, space, collection, id, 'upsert', actor);
  await env.DB.prepare(
    `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(space, collection, id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev,
     updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(space, collection, id, JSON.stringify(stored), rev, Date.now(), actor || 'system')
    .run();
  await afterWrite(env, space, collection, doc, id);
  return { record: { ...doc, id }, rev };
}

export async function updateRecord(env, space, collection, id, input, actor) {
  const def = COLLECTIONS[collection];
  if (!def) throw new HttpError(400, 'Unknown collection');
  const row = await env.DB.prepare(
    `SELECT doc FROM records WHERE space = ? AND collection = ? AND id = ?`,
  )
    .bind(space, collection, id)
    .first();
  if (!row) throw new HttpError(404, 'Record not found');
  const base = await revealDoc(env, collection, JSON.parse(row.doc));
  const merged = { ...base, ...(input || {}) };
  const doc = sanitizeDoc(collection, merged);
  if (def.autoId) doc.id = id;
  const stored = await protectDoc(env, collection, doc);
  const rev = await logChange(env, space, collection, id, 'upsert', actor);
  await env.DB.prepare(
    `UPDATE records SET doc = ?, rev = ?, updated_at = ?, updated_by = ? WHERE space = ? AND collection = ? AND id = ?`,
  )
    .bind(JSON.stringify(stored), rev, Date.now(), actor || 'system', space, collection, id)
    .run();
  await afterWrite(env, space, collection, doc, id);
  return { record: { ...doc, id }, rev };
}

export async function deleteRecord(env, space, collection, id, actor) {
  if (!COLLECTIONS[collection]) throw new HttpError(400, 'Unknown collection');
  const row = await env.DB.prepare(
    `SELECT id FROM records WHERE space = ? AND collection = ? AND id = ?`,
  )
    .bind(space, collection, id)
    .first();
  if (!row) throw new HttpError(404, 'Record not found');
  await env.DB.prepare(`DELETE FROM records WHERE space = ? AND collection = ? AND id = ?`)
    .bind(space, collection, id)
    .run();
  const rev = await logChange(env, space, collection, id, 'delete', actor);
  return { rev };
}

export async function bulkCreate(env, space, collection, docs, actor, dedupeKey) {
  if (!COLLECTIONS[collection]) throw new HttpError(400, 'Unknown collection');
  const stats = { added: 0, skipped: 0 };
  const existing = new Set();
  if (dedupeKey) {
    for (const rec of await listCollection(env, space, collection)) {
      const key = dedupeKey(rec);
      if (key) existing.add(key);
    }
  }
  const limit = Math.min(Array.isArray(docs) ? docs.length : 0, 5000);
  for (let i = 0; i < limit; i += 1) {
    const raw = docs[i];
    if (!raw || typeof raw !== 'object') continue;
    const key = dedupeKey ? dedupeKey(raw) : '';
    if (key && existing.has(key)) {
      stats.skipped += 1;
      continue;
    }
    if (key) existing.add(key);
    await createRecord(env, space, collection, raw, actor);
    stats.added += 1;
  }
  return stats;
}

/* ---------------------------------------------------- state for the client */

function parseDocs(rows) {
  return rows.map((r) => {
    const doc = JSON.parse(r.doc);
    doc.id = r.id;
    return doc;
  });
}

let familyChecked = false;

/** Existing databases predate the family module: backfill members once from the seed. */
export async function ensureFamilySeed(env) {
  if (familyChecked) return;
  const flag = await getMeta(env, 'family_seed', 0);
  if (flag) {
    familyChecked = true;
    return;
  }
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE space = 'family' AND collection = 'family'`).first();
  if (!row || !row.n) {
    for (const member of SEED.family || []) await createRecord(env, 'family', 'family', member, 'system');
  }
  await setMeta(env, 'family_seed', Date.now());
  familyChecked = true;
}

let subsChecked = false;

/** Subscriptions arrived later than the first deployments, so they get their own flag. */
export async function ensureSubscriptionSeed(env) {
  if (subsChecked) return;
  const flag = await getMeta(env, 'subs_seed', 0);
  if (flag) {
    subsChecked = true;
    return;
  }
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE space = 'family' AND collection = 'subscriptions'`).first();
  if (!row || !row.n) {
    for (const sub of SEED.subscriptions || []) await createRecord(env, 'family', 'subscriptions', sub, 'system');
  }
  await setMeta(env, 'subs_seed', Date.now());
  subsChecked = true;
}

export async function getState(env, since, space = 'family') {
  if (space === 'family') {
    await ensureFamilySeed(env);
    await ensureSubscriptionSeed(env);
  }

  // Two batched round-trips instead of six sequential ones: metadata + notifications
  // first, then the record diff (or the full snapshot). Every row is scoped to the
  // requested space, so a personal book can never contain another member's rows.
  const [headRes, floorRes, settingsRes, vapidRes, notesRes, unreadRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS rev FROM changes WHERE space = ?`).bind(space),
    env.DB.prepare(`SELECT v FROM meta WHERE k = 'floor'`),
    env.DB.prepare(`SELECT v FROM meta WHERE k = 'settings'`),
    env.DB.prepare(`SELECT v FROM meta WHERE k = 'vapid'`),
    env.DB.prepare(`SELECT * FROM notifications WHERE space = ? ORDER BY created_at DESC LIMIT 40`).bind(space),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE space = ? AND read_at IS NULL`).bind(space),
  ]);

  const first = (result) => (result && result.results && result.results[0]) || null;
  const parseMeta = (row, fallback) => {
    if (!row) return fallback;
    try {
      return JSON.parse(row.v);
    } catch {
      return fallback;
    }
  };

  const head = first(headRes);
  const rev = head ? head.rev : 0;
  const floor = Number(parseMeta(first(floorRes), 0)) || 0;
  const full = !since || since <= 0 || since < floor;
  const settings = parseMeta(first(settingsRes), SETTINGS);
  const vapid = parseMeta(first(vapidRes), null);
  const notifications = notesRes && notesRes.results ? notesRes.results : [];
  const unreadRow = first(unreadRes);

  const collections = {};
  const deleted = {};

  const recordsStmt = full
    ? env.DB.prepare(`SELECT collection, id, doc FROM records WHERE space = ?`).bind(space)
    : env.DB.prepare(`SELECT collection, id, doc FROM records WHERE space = ? AND rev > ?`).bind(space, since);
  const removedStmt = full
    ? env.DB.prepare(`SELECT collection, record_id FROM changes WHERE 0`)
    : env.DB.prepare(`SELECT collection, record_id FROM changes WHERE space = ? AND seq > ? AND op = 'delete'`).bind(space, since);

  const [recordsRes, removedRes] = await env.DB.batch([recordsStmt, removedStmt]);

  if (full) {
    for (const name of COLLECTION_NAMES) collections[name] = [];
  }
  for (const row of (recordsRes && recordsRes.results) || []) {
    if (!collections[row.collection]) collections[row.collection] = [];
    const plain = await revealDoc(env, row.collection, JSON.parse(row.doc));
    collections[row.collection].push({ ...plain, id: row.id });
  }
  if (full) {
    for (const name of COLLECTION_NAMES) collections[name].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  for (const row of (removedRes && removedRes.results) || []) {
    if (!deleted[row.collection]) deleted[row.collection] = [];
    deleted[row.collection].push(row.record_id);
  }

  return {
    rev,
    full,
    space,
    collections,
    deleted,
    settings,
    notifications,
    unread: unreadRow ? unreadRow.n : 0,
    pushPublicKey: vapid ? vapid.publicKey || null : null,
    serverTime: Date.now(),
  };
}

export async function activityFeed(env, space, limit = 25) {
  const res = await env.DB.prepare(
    `SELECT c.seq, c.collection, c.record_id, c.op, c.actor, c.ts, r.doc
       FROM changes c LEFT JOIN records r ON r.space = c.space AND r.collection = c.collection AND r.id = c.record_id
      WHERE c.space = ? AND c.op IN ('upsert','delete') ORDER BY c.seq DESC LIMIT ?`,
  )
    .bind(space, limit)
    .all();
  return (res.results || []).map((row) => {
    let label = row.record_id;
    if (row.doc) {
      const doc = JSON.parse(row.doc);
      label = doc.name || doc.title || doc.payee || doc.source || doc.item || doc.id || row.record_id;
    }
    return {
      seq: row.seq,
      collection: row.collection,
      label,
      op: row.op,
      actor: row.actor,
      ts: row.ts,
    };
  });
}

/* --------------------------------------------------------- notifications */

export async function listNotifications(env, space, limit = 40) {
  const res = await env.DB.prepare(
    `SELECT * FROM notifications WHERE space = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(space, limit)
    .all();
  return res.results || [];
}

export async function countUnread(env, space) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE space = ? AND read_at IS NULL`)
    .bind(space)
    .first();
  return row ? row.n : 0;
}

export async function markRead(env, space, ids) {
  if (!ids || !ids.length) {
    await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE space = ? AND read_at IS NULL`)
      .bind(Date.now(), space)
      .run();
    return;
  }
  for (const id of ids.slice(0, 200)) {
    await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE space = ? AND id = ? AND read_at IS NULL`)
      .bind(Date.now(), space, String(id))
      .run();
  }
}

/**
 * Insert a notification once per (type, record, bucket). Returns the row when it
 * was actually created, so the caller can push it to subscribed devices.
 */
export async function addNotification(env, n) {
  const id = crypto.randomUUID();
  const space = n.space || 'family';
  const res = await env.DB.prepare(
    `INSERT INTO notifications (id, space, type, title, body, level, collection, record_id, created_at, dedupe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe) DO NOTHING`,
  )
    .bind(
      id,
      space,
      n.type,
      String(n.title).slice(0, 160),
      String(n.body).slice(0, 400),
      n.level || 'info',
      n.collection || null,
      n.recordId || null,
      Date.now(),
      n.dedupe,
    )
    .run();
  const created = res.meta && res.meta.changes > 0;
  if (!created) return null;
  await logChange(env, space, 'notifications', id, 'notify', 'system');
  return { id, type: n.type, title: n.title, body: n.body, level: n.level || 'info', createdAt: Date.now() };
}

/** Domain events: bill due, renewal, task, birthday, budget drift. */
export async function sweep(env, { force = false } = {}) {
  const last = await getMeta(env, 'sweep', 0);
  if (!force && Date.now() - last < SWEEP_INTERVAL_MS) return [];
  await setMeta(env, 'sweep', Date.now());

  const created = [];
  const push = async (n) => {
    const row = await addNotification(env, n);
    if (row) created.push(row);
  };

  const payments = await listCollection(env, 'family', 'payments');
  for (const p of payments) {
    if (p.status === 'Paid') continue;
    const d = daysTo(p.due);
    if (d === null || d > 3) continue;
    const bucket = d < 0 ? 'overdue' : d === 0 ? 'today' : `d${d}`;
    const label = d < 0 ? `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}` : d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`;
    await push({
      type: 'bill_due',
      title: `${label}: ${p.payee || 'Bill'}`,
      body: `₹${Math.round(Number(p.amount) || 0).toLocaleString('en-IN')} · ${p.contact || p.mode || ''}`.trim(),
      level: d <= 0 ? 'high' : 'medium',
      collection: 'payments',
      recordId: p.id,
      dedupe: `bill:${p.id}:${bucket}`,
    });
  }

  const insurance = await listCollection(env, 'family', 'insurance');
  for (const p of insurance) {
    const d = daysTo(p.renewal);
    if (d === null || d > 30 || d < 0) continue;
    const bucket = d <= 1 ? 'd1' : d <= 7 ? 'd7' : 'd30';
    await push({
      type: 'renewal',
      title: `Renewal in ${d} day${d === 1 ? '' : 's'}: ${p.name || 'Policy'}`,
      body: `${p.insurer || ''} · premium ₹${Math.round(Number(p.premium) || 0).toLocaleString('en-IN')}`,
      level: d <= 7 ? 'high' : 'medium',
      collection: 'insurance',
      recordId: p.id,
      dedupe: `ins:${p.id}:${bucket}`,
    });
  }

  const diary = await listCollection(env, 'family', 'diary');
  for (const t of diary) {
    if (t.status === 'Completed') continue;
    const due = t.due || t.date;
    const d = daysTo(due);
    if (d === null || d > 3) continue;
    const bucket = d < 0 ? 'overdue' : d === 0 ? 'today' : `d${d}`;
    await push({
      type: 'task_due',
      title: d < 0 ? `Task overdue: ${t.title}` : d === 0 ? `Task due today: ${t.title}` : `Task in ${d} day${d === 1 ? '' : 's'}: ${t.title}`,
      body: t.follow || t.contact || '',
      level: t.priority === 'High' ? 'high' : 'info',
      collection: 'diary',
      recordId: t.id,
      dedupe: `task:${t.id}:${bucket}`,
    });
  }

  const subscriptions = await listCollection(env, 'family', 'subscriptions');
  for (const s of subscriptions) {
    if (s.status !== 'Active') continue;
    const d = daysTo(s.nextDue);
    if (d === null || d > 3) continue;
    const bucket = d < 0 ? 'overdue' : d === 0 ? 'today' : `d${d}`;
    await push({
      type: 'subscription',
      title: `${s.service || 'Subscription'} renews ${d < 0 ? 'was due' : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}`,
      body: `₹${Math.round(Number(s.amount) || 0).toLocaleString('en-IN')} · ${s.cycle || ''}`,
      level: d <= 1 ? 'high' : 'info',
      collection: 'subscriptions',
      recordId: s.id,
      dedupe: `sub:${s.id}:${bucket}`,
    });
  }

  const contacts = await listCollection(env, 'family', 'contacts');
  for (const c of contacts) {
    const days = birthdayIn(c.bday);
    if (days === null || days > 7) continue;
    await push({
      type: 'birthday',
      title: days === 0 ? `🎂 ${c.name} - birthday today` : `🎂 ${c.name} - birthday in ${days} day${days === 1 ? '' : 's'}`,
      body: `${c.rel || 'Contact'}${c.mobile ? ` · ${c.mobile}` : ''}`,
      level: 'info',
      collection: 'contacts',
      recordId: c.id,
      dedupe: `bday:${c.id}:${istToday()}`,
    });
  }

  if (created.length) {
    await sendPushToAll(env, created);
  }
  return created;
}

function birthdayIn(bday) {
  const s = String(bday || '');
  const m = s.match(/^(?:\d{4}|--)-(\d{2})-(\d{2})/);
  if (!m) return null;
  const today = new Date(`${istToday()}T00:00:00Z`);
  let next = new Date(Date.UTC(today.getUTCFullYear(), Number(m[1]) - 1, Number(m[2])));
  if (next < today) next = new Date(Date.UTC(today.getUTCFullYear() + 1, Number(m[1]) - 1, Number(m[2])));
  return Math.round((next - today) / 86400000);
}

/** Extra check right after a write: budget drift notification. */
async function afterWrite(env, space, collection, doc, id) {
  if (collection !== 'budgetEx') return;
  const planned = Number(doc.planned) || 0;
  const actual = Number(doc.actual) || 0;
  if (planned <= 0 || actual <= planned) return;
  const month = istToday().slice(0, 7);
  const row = await addNotification(env, {
    type: 'budget_over',
    title: `Over budget: ${doc.source || 'category'}`,
    body: `Actual ₹${Math.round(actual).toLocaleString('en-IN')} vs planned ₹${Math.round(planned).toLocaleString('en-IN')}`,
    level: 'medium',
    space,
    collection: 'budgetEx',
    recordId: id,
    dedupe: `budget:${space}:${id}:${month}:${Math.round(actual)}`,
  });
  if (row) await sendPushToAll(env, [row]);
}

/* --------------------------------------------------------------- seeding */

export async function seedDatabase(env, actor = 'system') {
  for (const name of Object.keys(SEED)) {
    if (!COLLECTIONS[name]) continue;
    const rows = SEED[name];
    for (const row of rows) await createRecord(env, 'family', name, row, actor);
  }
  await setMeta(env, 'settings', SETTINGS);
  await setMeta(env, 'family_seed', Date.now());
  familyChecked = true;
  const vapid = await getMeta(env, 'vapid', null);
  if (!vapid) await setMeta(env, 'vapid', await generateVapidKeys());
  await setMeta(env, 'seeded', Date.now());
  await setMeta(env, 'floor', 0);
  await sweep(env, { force: true });
}

export async function wipeRecords(env, space = null) {
  if (space) {
    await env.DB.prepare(`DELETE FROM records WHERE space = ?`).bind(space).run();
    await env.DB.prepare(`DELETE FROM notifications WHERE space = ?`).bind(space).run();
    await env.DB.prepare(`DELETE FROM changes WHERE space = ?`).bind(space).run();
    return;
  }
  await env.DB.prepare(`DELETE FROM records`).run();
  await env.DB.prepare(`DELETE FROM notifications`).run();
  await env.DB.prepare(`DELETE FROM changes`).run();
  await setMeta(env, 'floor', 0);
  await env.DB.prepare(`DELETE FROM meta WHERE k IN ('family_seed', 'subs_seed')`).run();
  familyChecked = false;
  subsChecked = false;
}

export async function pruneChanges(env) {
  const cutoff = Date.now() - CHANGE_RETENTION_DAYS * 86400000;
  const last = await getMeta(env, 'prune', 0);
  if (Date.now() - last < 86400000) return;
  const head = await env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS rev FROM changes`).first();
  await setMeta(env, 'prune', Date.now());
  await env.DB.prepare(`DELETE FROM changes WHERE ts < ?`).bind(cutoff).run();
  await setMeta(env, 'floor', head ? head.rev : 0);
}

/* ------------------------------------------------------------- http error */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export { parseDocs };
