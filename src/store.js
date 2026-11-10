// Data + auth layer. Everything here runs on the Worker and talks to D1 with
// bound parameters only - no string interpolation of user input ever reaches SQL.

import { COLLECTIONS, COLLECTION_NAMES, sanitizeDoc } from '../web/src/entities.js';
import { SEED, SETTINGS } from './seed.js';
import { generateVapidKeys, sendPushToAll } from './push.js';
import { protectDoc, revealDoc, encryptionReady } from './fieldcrypto.js';
import { HttpError } from './errors.js';
import { ensureProfiles, spaceForProfile } from './profiles.js';
import { matchTotp, newRecoveryCode, normaliseRecoveryCode, otpauthUri, randomBase32 } from './twofactor.js';
import { applyMigrations, pendingMigrations } from './migrations/runner.js';
import { queueNotification } from './telegram.js';

export const SCHEMA_VERSION = '13';
// 100 000 is the maximum iteration count the production Workers runtime supports
// for PBKDF2-SHA256; attempts are additionally rate limited (8 per 15 minutes per IP).
const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 30;
const SWEEP_INTERVAL_MS = 60 * 1000;
const CHANGE_RETENTION_DAYS = 30;

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
  // Fresh databases (or one where the owner was removed) must always have an owner.
  const owner = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`).first();
  if (!owner || !owner.n) {
    await env.DB.prepare(
      `UPDATE users SET role = 'owner' WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1)`,
    ).run();
  }
  // Every account belongs to exactly one household. Existing rows keep the
  // original shared book ('family'); self-serve signups get 'h:<their id>'.
  if (!(await hasColumn(env, 'users', 'household'))) {
    try {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN household TEXT NOT NULL DEFAULT 'family'`).run();
    } catch {
      /* already present */
    }
  }
  if (!(await hasColumn(env, 'family_invites', 'household'))) {
    try {
      await env.DB.prepare(`ALTER TABLE family_invites ADD COLUMN household TEXT NOT NULL DEFAULT 'family'`).run();
    } catch {
      /* already present */
    }
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
  // The meta row records that the historic repair steps ran, but the chain keeps
  // growing: a database that already carries the current version still needs any
  // migration added after it. Gating on the version alone left new migrations
  // unapplied on every existing deployment.
  if (current === SCHEMA_VERSION) {
    let pending = null;
    try {
      pending = await pendingMigrations(env);
    } catch {
      pending = null; // no schema_migrations table yet: run the chain
    }
    if (pending && pending.length === 0) {
      schemaReady = true;
      return;
    }
  }
  // v5 adds personal/family spaces. This has to run before the schema
  // migrations, because a pre-v5 `records` table is renamed and refilled here
  // and the baseline only creates tables that are missing.
  await migrateSpaces(env);
  // Every table, constraint and index is defined in src/migrations/index.js and
  // applied once, in order, recorded in `schema_migrations`. Nothing below may
  // hand-edit the schema.
  const applied = await applyMigrations(env, (event, id) => console.log(event, id));
  if (applied.length) console.log('schema: applied', applied.join(', '));
  // Data-only repairs for rows written before roles and households existed.
  await migrateV6(env);
  // v9: give every existing account a personal + office profile and the family
  // profile of its household. Additive and idempotent, so a deploy never locks
  // anyone out of data they could already read.
  await ensureProfiles(env);
  // Accounts that were created inside another person's book get their own one.
  await splitMixedHouseholds(env);
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

/**
 * Read and delete a one-shot value (sign-in state, login ticket). The DELETE is a
 * single statement and its change count decides the winner, so two concurrent
 * callers cannot both redeem the same ticket.
 */
export async function takeMeta(env, key) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`).bind(key).first();
  if (!row) return null;
  const out = await env.DB.prepare(`DELETE FROM meta WHERE k = ?`).bind(key).run();
  if (!out || !out.meta || Number(out.meta.changes) !== 1) return null;
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
  // The account that sets up the planner owns the original household book. A
  // second PIN account gets its own book instead of silently sharing the first
  // one, which is how two people used to end up writing into the same rows.
  const first = (await countUsers(env)) === 0;
  const home = first ? 'family' : `h:${id}`;
  await env.DB.prepare(
    `INSERT INTO users (id, name, pin_hash, pin_salt, iterations, created_at, role, household) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      String(name).trim().slice(0, 60) || 'Family',
      hash,
      salt,
      PBKDF2_ITERATIONS,
      Date.now(),
      'owner',
      home,
    )
    .run();
  await ensureProfiles(env);
  return { id, name, role: 'owner', household: home };
}

/**
 * PIN sign-in. Every account that has a PIN is checked, so a second person's PIN
 * opens their own plan instead of only ever matching the first row in `users`.
 * PINs are only 4-12 digits, so the caller's lockout still matters here.
 */
export async function verifyPin(env, pin) {
  const rows = (await env.DB.prepare(
    `SELECT id, name, household, pin_hash, pin_salt, iterations FROM users WHERE length(pin_hash) > 0`,
  ).all()).results || [];
  const value = String(pin || '');
  let match = null;
  for (const user of rows) {
    const candidate = await derivePin(value, user.pin_salt, user.iterations || PBKDF2_ITERATIONS);
    // Compare every row so the response time does not depend on which PIN matched.
    if (timingSafeEqual(candidate, user.pin_hash)) match = { id: user.id, name: user.name };
  }
  return match;
}

export async function getUser(env, userId) {
  return env.DB.prepare(
    `SELECT id, name, role, household, created_at, totp_enabled, totp_secret, totp_last_step, length(recovery_hash) AS has_recovery
       FROM users WHERE id = ?`,
  )
    .bind(String(userId))
    .first();
}

/** Rename the signed-in account; the email stays with the credential row. */
export async function updateAccountName(env, userId, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new HttpError(400, 'Enter a name');
  await env.DB.prepare(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`)
    .bind(clean, Date.now(), String(userId))
    .run();
  return clean;
}

/** Replace the PIN for one account (not the household PIN of an older build). */
export async function setUserPin(env, userId, pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(String(pin), salt, PBKDF2_ITERATIONS);
  await env.DB.prepare(
    `UPDATE users SET pin_hash = ?, pin_salt = ?, iterations = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(hash, salt, PBKDF2_ITERATIONS, Date.now(), String(userId))
    .run();
}

/**
 * A recovery code is the only way back in when the PIN is forgotten: there is no
 * email sender in this deployment, so the code is generated once and shown to
 * the person who must keep it. Only its PBKDF2 hash is stored.
 */
export async function createRecoveryCode(env, userId) {
  const code = newRecoveryCode();
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(normaliseRecoveryCode(code), salt, PBKDF2_ITERATIONS);
  await env.DB.prepare(
    `UPDATE users SET recovery_hash = ?, recovery_salt = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(hash, salt, Date.now(), String(userId))
    .run();
  return code;
}

/**
 * Reset a PIN with a recovery code. Returns the user id on success. The code is
 * single-use: it is replaced by a freshly generated one, which the caller shows
 * and the user stores again.
 */
export async function recoverWithCode(env, code, newPin) {
  const normalised = normaliseRecoveryCode(code);
  if (normalised.length < 12) throw new HttpError(400, 'Enter the full recovery code');
  const rows = (await env.DB.prepare(
    `SELECT id, recovery_hash, recovery_salt, iterations FROM users WHERE length(recovery_hash) > 0`,
  ).all()).results || [];
  let found = null;
  for (const row of rows) {
    const candidate = await derivePin(normalised, row.recovery_salt, row.iterations || PBKDF2_ITERATIONS);
    if (timingSafeEqual(candidate, row.recovery_hash)) found = row;
  }
  if (!found) return null;
  await setUserPin(env, found.id, newPin);
  await deleteUserSessions(env, found.id);
  return found.id;
}

/* --------------------------------------------------------- email OTP reset */

const OTP_MINUTES = 10;
const OTP_ATTEMPTS = 5;

/**
 * A six-digit code, stored only as a PBKDF2 hash with a ten-minute lifetime and a
 * hard attempt ceiling. Requesting a new code replaces the old one, so an old
 * message cannot be replayed.
 */
export async function createEmailOtp(env, email) {
  const clean = normaliseEmail(email);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(code, salt, PBKDF2_ITERATIONS);
  await env.DB.prepare(
    `INSERT INTO email_otps (email, code_hash, salt, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt,
       expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`,
  )
    .bind(clean, hash, salt, Date.now() + OTP_MINUTES * 60_000, Date.now())
    .run();
  return { code, minutes: OTP_MINUTES };
}

/** True when the code matched; the row is consumed on success either way. */
export async function consumeEmailOtp(env, email, code) {
  const clean = normaliseEmail(email);
  const row = await env.DB.prepare(`SELECT * FROM email_otps WHERE email = ?`).bind(clean).first();
  if (!row) return false;
  if (row.expires_at < Date.now() || (row.attempts || 0) >= OTP_ATTEMPTS) {
    await env.DB.prepare(`DELETE FROM email_otps WHERE email = ?`).bind(clean).run();
    return false;
  }
  const candidate = await derivePin(String(code || '').trim(), row.salt, PBKDF2_ITERATIONS);
  if (!timingSafeEqual(candidate, row.code_hash)) {
    await env.DB.prepare(`UPDATE email_otps SET attempts = attempts + 1 WHERE email = ?`).bind(clean).run();
    return false;
  }
  await env.DB.prepare(`DELETE FROM email_otps WHERE email = ?`).bind(clean).run();
  return true;
}

/* ------------------------------------------------------------- social login */

/**
 * The account-linking rule, in one place.
 *
 *   1. A provider identity that has signed in before keeps its account. This is
 *      the only rule that can override an email match, so renaming an address at
 *      the provider cannot move an account to somebody else.
 *   2. Otherwise the provider's address must be confirmed by the provider. An
 *      unconfirmed address cannot claim an existing account and cannot create a
 *      new one.
 *   3. A confirmed address that already has an account (password, PIN or another
 *      provider) links to that account: one household, several ways in.
 *   4. A confirmed address with no account creates one, with an empty password so
 *      only the provider can sign into it until the owner sets one.
 *
 * The outcome is returned rather than guessed, so the caller can audit whether a
 * sign-in created an account, linked a provider or simply reused a link.
 */
export async function resolveOauthAccount(env, { provider, providerId, email, name, emailVerified }) {
  const clean = normaliseEmail(email);
  const id = String(providerId || '');
  if (!id) throw new HttpError(401, 'The provider did not identify the account');

  const linked = await env.DB.prepare(`SELECT user_id FROM oauth_links WHERE provider = ? AND provider_id = ?`)
    .bind(provider, id)
    .first();
  if (linked) {
    const row = await env.DB.prepare(`SELECT id, name FROM users WHERE id = ?`).bind(linked.user_id).first();
    if (row) return { user: { id: row.id, name: row.name, email: clean }, outcome: 'existing-link' };
  }

  if (!clean || !isEmail(clean) || !emailVerified) {
    throw new HttpError(403, 'That account has no confirmed email address, so it cannot be linked. Confirm the address with the provider and try again.');
  }

  let userId = '';
  let outcome = 'linked-by-email';
  const existing = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`).bind(clean).first();
  if (existing) {
    userId = existing.user_id;
  } else {
    outcome = 'created';
    userId = crypto.randomUUID();
    const home = `h:${userId}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, name, pin_hash, pin_salt, iterations, created_at, role, household) VALUES (?, ?, '', '', ?, ?, 'owner', ?)`,
      ).bind(userId, String(name || clean.split('@')[0]).slice(0, 60), PBKDF2_ITERATIONS, Date.now(), home),
      env.DB.prepare(
        `INSERT INTO credentials (user_id, email, password_hash, password_salt, iterations, created_at) VALUES (?, ?, '', '', ?, ?)`,
      ).bind(userId, clean, PBKDF2_ITERATIONS, Date.now()),
    ]);
    await ensureProfiles(env);
  }
  await env.DB.prepare(
    `INSERT INTO oauth_links (provider, provider_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_id) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`,
  )
    .bind(provider, id, userId, clean, Date.now())
    .run();
  const row = await env.DB.prepare(`SELECT id, name FROM users WHERE id = ?`).bind(userId).first();
  if (!row) throw new HttpError(401, 'Could not create the account');
  return { user: { id: row.id, name: row.name, email: clean }, outcome };
}

/** Kept for callers that only need the account. */
export async function findOrCreateOauthUser(env, identity) {
  const { user } = await resolveOauthAccount(env, identity);
  return user;
}

/* ------------------------------------------------------------------- 2fa */

export async function totpState(env, userId) {
  const user = await getUser(env, userId);
  return { enabled: Boolean(user && user.totp_enabled), pending: Boolean(user && user.totp_secret && !user.totp_enabled) };
}

/** Start enrolment: generate and store a secret that is not active yet. */
export async function beginTotp(env, userId, account) {
  const user = await getUser(env, userId);
  // Never let a setup call silently drop an active second factor.
  if (user && user.totp_enabled) throw new HttpError(400, 'Two-factor is already on. Turn it off first.');
  const secret = randomBase32(20);
  await env.DB.prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?`)
    .bind(secret, String(userId))
    .run();
  return { secret, uri: otpauthUri({ secret, account }) };
}

export async function enableTotp(env, userId, code) {
  const user = await getUser(env, userId);
  if (!user || !user.totp_secret) throw new HttpError(400, 'Start the setup again');
  const step = await matchTotp(user.totp_secret, code, 0);
  if (!step) throw new HttpError(400, 'That code is not valid. Check the clock on your phone.');
  await env.DB.prepare(`UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?`)
    .bind(step, String(userId))
    .run();
  return true;
}

export async function disableTotp(env, userId) {
  await env.DB.prepare(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?`)
    .bind(String(userId))
    .run();
}

/**
 * Verify a login code and burn the time step it belongs to, so the same six
 * digits cannot be used twice (RFC 6238 section 5.2).
 */
export async function verifyTotp(env, userId, code) {
  const user = await getUser(env, userId);
  if (!user || !user.totp_enabled || !user.totp_secret) return true;
  const step = await matchTotp(user.totp_secret, code, user.totp_last_step || 0);
  if (!step) return false;
  await env.DB.prepare(`UPDATE users SET totp_last_step = ? WHERE id = ?`).bind(step, String(userId)).run();
  return true;
}

export async function accountHasTotp(env, userId) {
  const user = await getUser(env, userId);
  return Boolean(user && user.totp_enabled);
}

/**
 * One-time repair for databases created before signup accounts got their own
 * book: accounts that are not the household owner are moved to `h:<id>` and the
 * rows they wrote follow them, so nothing is lost and nobody sees a stranger's
 * data any more.
 */
export async function splitMixedHouseholds(env) {
  if (await getMeta(env, 'household_split', 0)) return 0;
  const users = (await env.DB.prepare(
    `SELECT id, role, household FROM users ORDER BY created_at`,
  ).all()).results || [];
  const owner = users.find((u) => (u.household || 'family') === 'family');
  if (!owner) {
    await setMeta(env, 'household_split', Date.now());
    return 0;
  }
  let moved = 0;
  for (const user of users) {
    if (user === owner || (user.household || 'family') !== 'family') continue;
    const home = `h:${user.id}`;
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET household = ?, role = 'owner' WHERE id = ?`).bind(home, user.id),
      env.DB.prepare(`UPDATE records SET space = ? WHERE space = 'family' AND updated_by = ?`).bind(home, user.id),
    ]);
    try {
      await env.DB.prepare(`UPDATE files SET space = ? WHERE space = 'family' AND user_id = ?`).bind(home, user.id).run();
    } catch {
      /* older databases have no user_id column on files */
    }
    await env.DB.prepare(`DELETE FROM profile_members WHERE profile_id = 'family' AND user_id = ?`)
      .bind(user.id)
      .run();
    moved += 1;
  }
  await ensureProfiles(env);
  await setMeta(env, 'household_split', Date.now());
  return moved;
}

/* --------------------------------------------- email + password accounts */

const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;

export function isStrongPassword(password) {
  return PASSWORD_RE.test(String(password || ''));
}

export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 160);
}

/**
 * Check a PIN against one account only. `verifyPin` answers "whose PIN is this?"
 * for sign-in, which is the wrong question for an already-authenticated session:
 * a member must not be able to authorise a password change with the owner's PIN.
 */
export async function verifyUserPin(env, userId, pin) {
  const row = await env.DB.prepare(
    `SELECT pin_hash, pin_salt, iterations FROM users WHERE id = ? AND length(pin_hash) > 0`,
  )
    .bind(String(userId))
    .first();
  if (!row) return false;
  const candidate = await derivePin(String(pin || ''), row.pin_salt, row.iterations || PBKDF2_ITERATIONS);
  return timingSafeEqual(candidate, row.pin_hash);
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
export async function createEmailUser(env, email, password, name, household = null) {
  const clean = normaliseEmail(email);
  const existing = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`).bind(clean).first();
  if (existing) throw new HttpError(409, 'That email already has an account');
  const userId = crypto.randomUUID();
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(password, salt, PBKDF2_ITERATIONS);
  const displayName = String(name || clean.split('@')[0]).trim().slice(0, 60) || 'Member';
  // Without an invite the account starts its own private planner and owns it.
  const home = household || `h:${userId}`;
  const role = household ? 'member' : 'owner';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, name, pin_hash, pin_salt, iterations, created_at, role, household) VALUES (?, ?, '', '', ?, ?, ?, ?)`,
    ).bind(userId, displayName, PBKDF2_ITERATIONS, Date.now(), role, home),
    env.DB.prepare(
      `INSERT INTO credentials (user_id, email, password_hash, password_salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(userId, clean, hash, salt, PBKDF2_ITERATIONS, Date.now()),
  ]);
  // Personal, office and (joined or new) family profiles for the new account.
  await ensureProfiles(env);
  return { id: userId, name: displayName, email: clean, household: home, role };
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

export async function listMembers(env, household = 'family') {
  const res = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.created_at, c.email
       FROM users u LEFT JOIN credentials c ON c.user_id = u.id
      WHERE u.household = ? ORDER BY u.created_at`,
  )
    .bind(household)
    .all();
  return res.results || [];
}

export async function memberRole(env, userId) {
  const row = await env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(userId).first();
  return row ? row.role : null;
}

export async function createInvite(env, userId, household = 'family') {
  const code = randomToken(9).replace(/[-_]/g, '').slice(0, 10).toUpperCase();
  const expiresAt = Date.now() + 72 * 3600000;
  await env.DB.prepare(
    `INSERT INTO family_invites (code, created_by, role, expires_at, household) VALUES (?, ?, 'member', ?, ?)`,
  )
    .bind(code, userId, expiresAt, household)
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
  const clean = String(code || '').trim().toUpperCase();
  const row = await env.DB.prepare(
    `SELECT household, role FROM family_invites WHERE code = ? AND used_by IS NULL`,
  )
    .bind(clean)
    .first();
  if (!row) return null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE family_invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`)
      .bind(userId, Date.now(), clean),
    env.DB.prepare(`UPDATE users SET household = ?, role = ? WHERE id = ?`)
      .bind(row.household || 'family', row.role || 'member', userId),
  ]);
  return row;
}

/**
 * Removing a member deletes their private books, documents, memberships and
 * sessions. The household book's records are untouched because they are shared.
 */
export async function removeMember(env, userId, household = null, actorId = null) {
  if (household) {
    const target = await env.DB.prepare(`SELECT household FROM users WHERE id = ?`).bind(userId).first();
    if (!target || (target.household || 'family') !== household) throw new HttpError(404, 'Member not found');
  }
  const spaces = [spaceForProfile('personal', userId), spaceForProfile('office', userId)];
  // Documents are deleted from R2 before their rows disappear, so no orphaned
  // object survives the account that owned it.
  if (env.FILES) {
    try {
      const rows = await env.DB.prepare(
        `SELECT key FROM files WHERE space = ? OR space = ?`,
      ).bind(spaces[0], spaces[1]).all();
      for (const row of rows.results || []) await env.FILES.delete(row.key);
    } catch {
      /* storage best effort */
    }
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM credentials WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM profile_members WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM profiles WHERE owner_id = ? AND kind IN ('personal','office')`).bind(userId),
    env.DB.prepare(`DELETE FROM records WHERE space = ?`).bind(spaces[0]),
    env.DB.prepare(`DELETE FROM records WHERE space = ?`).bind(spaces[1]),
    env.DB.prepare(`DELETE FROM files WHERE space = ?`).bind(spaces[0]),
    env.DB.prepare(`DELETE FROM files WHERE space = ?`).bind(spaces[1]),
    env.DB.prepare(`DELETE FROM notifications WHERE space = ?`).bind(spaces[0]),
    env.DB.prepare(`DELETE FROM notifications WHERE space = ?`).bind(spaces[1]),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId),
  ]);
  if (household) {
    await env.DB.prepare(`DELETE FROM profile_members WHERE profile_id = ? AND user_id = ?`)
      .bind(household, userId)
      .run();
  }
  void actorId;
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

export async function listAiConnections(env, space) {
  const res = await env.DB.prepare(
    `SELECT id, provider, base_url, model, created_at FROM ai_connections WHERE profile_id = ? ORDER BY created_at`,
  )
    .bind(space)
    .all();
  return res.results || [];
}

export async function addAiConnection(env, input, userId, space) {
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
    `INSERT INTO ai_connections (id, provider, base_url, model, api_key, created_by, created_at, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, provider, baseUrl, model, apiKey, userId || null, Date.now(), space || 'family')
    .run();
  return { id, provider, base_url: baseUrl, model };
}

export async function deleteAiConnection(env, id, space) {
  await env.DB.prepare(`DELETE FROM ai_connections WHERE id = ? AND profile_id = ?`)
    .bind(String(id), space)
    .run();
}

export async function activeAiConnection(env, space = 'family') {
  return env.DB.prepare(`SELECT * FROM ai_connections WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(space)
    .first();
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
    `SELECT s.id, s.expires_at, u.id AS user_id, u.name, u.role, u.household FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
    return null;
  }
  return {
    sessionId: row.id,
    userId: row.user_id,
    name: row.name,
    role: row.role || 'member',
    household: row.household || 'family',
  };
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
    env.DB.prepare(`SELECT k, v FROM meta WHERE k = 'settings' OR k = ?`).bind(`settings:${space}`),
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
  // A profile's own settings win; the household row is the legacy fallback.
  const settingsRows = (settingsRes && settingsRes.results) || [];
  const settingsRow =
    settingsRows.find((r) => r.k === `settings:${space}`) ||
    settingsRows.find((r) => r.k === 'settings') ||
    null;
  const settings = parseMeta(settingsRow, SETTINGS);
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

/** Notification inbox spanning every profile the account can read. */
export async function listNotificationsAcross(env, profileIds, limit = 80) {
  const ids = (profileIds || []).filter(Boolean);
  if (!ids.length) return [];
  const holes = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT * FROM notifications WHERE space IN (${holes}) ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...ids, Math.min(Math.max(Number(limit) || 80, 1), 200))
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
  // Queued, not sent: the Telegram call happens in the background drain so a
  // slow or rate-limited bot cannot delay the write that raised the alert.
  await queueNotification(env, { id, space }).catch(() => {});
  return {
    id,
    space,
    type: n.type,
    title: n.title,
    body: n.body,
    level: n.level || 'info',
    createdAt: Date.now(),
  };
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

export async function seedDatabase(env, actor = 'system', space = 'family') {
  // Build every row in memory, then write them in a few batched statements.
  // The row-at-a-time version needed ~150 sequential D1 round trips, which made
  // the very first setup request outlive the browser's patience on a cold remote
  // database. Same rows, same ids, ~4 round trips.
  const rows = [];
  let contactSeq = 0;
  if (SEED.contacts && SEED.contacts.length) {
    const max = await env.DB.prepare(
      `SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS n FROM records WHERE space = ? AND collection = 'contacts' AND id LIKE 'CNT-%'`,
    )
      .bind(space)
      .first();
    contactSeq = (max && Number(max.n)) || 0;
  }
  for (const name of Object.keys(SEED)) {
    const def = COLLECTIONS[name];
    if (!def) continue;
    for (const input of SEED[name]) {
      const doc = sanitizeDoc(name, input);
      let id;
      if (def.autoId) {
        contactSeq += 1;
        id = `CNT-${String(contactSeq).padStart(4, '0')}`;
        doc.id = id;
      } else {
        const given = String((input && input.id) || '');
        id = /^[A-Za-z0-9_-]{1,64}$/.test(given) ? given : crypto.randomUUID();
      }
      rows.push({ collection: name, id, doc: JSON.stringify(await protectDoc(env, name, doc)) });
    }
  }

  const now = Date.now();
  // One change row for the whole seed keeps the revision stream cheap; clients
  // only need to see that the profile moved forward.
  const rev = await logChange(env, space, 'seed', 'seed', 'upsert', actor);
  const insert = `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(space, collection, id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev,
     updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(
      rows
        .slice(i, i + 50)
        .map((row) => env.DB.prepare(insert).bind(space, row.collection, row.id, row.doc, rev, now, actor || 'system')),
    );
  }

  // Settings are per profile, but the bare key is kept so an older client (and
  // the export format) still sees the same starter values.
  const meta = [
    ['settings', SETTINGS],
    [`settings:${space}`, SETTINGS],
    ['family_seed', now],
    ['seeded', now],
    ['floor', 0],
  ];
  const vapid = await getMeta(env, 'vapid', null);
  if (!vapid) meta.push(['vapid', await generateVapidKeys()]);
  await env.DB.batch(
    meta.map(([k, v]) =>
      env.DB.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(
        k,
        JSON.stringify(v),
      ),
    ),
  );
  familyChecked = true;
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

/* ---------------------------------------------------------- rate limits */

/**
 * Fixed-window limiter keyed per user. Returns true when the caller is over the
 * allowance. One statement, so a write costs one extra round-trip.
 */
export async function hitRateLimit(env, key, limit, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, hits) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.hits + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING hits`,
  )
    .bind(key, bucket)
    .first();
  return Boolean(row && Number(row.hits) > limit);
}

/* ------------------------------------------------------------- http error */

// Re-exported so existing imports of HttpError from the store keep working.
export { HttpError } from './errors.js';

export { parseDocs };
