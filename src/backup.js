// Backup format and restore.
//
// A backup is plain, versioned JSON: the user owns the data and must be able to
// read it without this app. What makes it safe to keep in a drive is the checksum
// and the profile list, not encryption — the file sits in the provider's private
// app folder, which only this app can read.
//
// Money is written as integer paise. Storage still holds rupees as JSON numbers
// (the migration to integer minor units is a separate, approved change), so the
// export converts and the restore converts back. Declaring the unit in the file
// means a future reader does not have to guess.

import { COLLECTIONS } from '../web/src/entities.js';
import { deleteBackup, listBackups, uploadBackup, CLOUD_PROVIDERS } from './cloud.js';
import { HttpError } from './errors.js';
import { listProfiles } from './profiles.js';
import { sha256Hex } from './store.js';

export const BACKUP_FORMAT = 'ffp-backup';
export const BACKUP_SCHEMA_VERSION = 2;
export const MAX_RESTORE_ROWS = 900; // one D1 batch, which is one transaction

const MONEY_FIELDS = Object.fromEntries(
  Object.entries(COLLECTIONS).map(([name, spec]) => [
    name,
    spec.fields.filter((f) => f.t === 'money').map((f) => f.k),
  ]),
);

/** Rupees (the stored shape) → integer paise (the exported shape). */
export function toPaise(doc, collection) {
  const fields = MONEY_FIELDS[collection] || [];
  if (!fields.length) return doc;
  const out = { ...doc };
  for (const key of fields) {
    if (out[key] === undefined || out[key] === null || out[key] === '') continue;
    const n = Number(out[key]);
    if (Number.isFinite(n)) out[key] = Math.round(n * 100);
  }
  return out;
}

/** Integer paise (the exported shape) → rupees (the stored shape). */
export function fromPaise(doc, collection) {
  const fields = MONEY_FIELDS[collection] || [];
  if (!fields.length) return doc;
  const out = { ...doc };
  for (const key of fields) {
    if (out[key] === undefined || out[key] === null || out[key] === '') continue;
    const n = Number(out[key]);
    if (Number.isFinite(n)) out[key] = Math.round(n) / 100;
  }
  return out;
}

/** Stable JSON: keys sorted, so the same data always hashes the same way. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export async function checksumOf(payload) {
  const { checksum, ...rest } = payload;
  return sha256Hex(canonical(rest));
}

/** Everything the account can read, in the format above. */
export async function buildExport(env, userId, { appVersion = '', includeEmail = '' } = {}) {
  const profiles = await listProfiles(env, userId);
  const data = {};
  const profileList = [];
  let records = 0;

  for (const profile of profiles) {
    const rows = (await env.DB.prepare(
      `SELECT collection, id, doc, rev, updated_at FROM records WHERE space = ? ORDER BY collection, id`,
    )
      .bind(profile.id)
      .all()).results || [];
    const byCollection = {};
    for (const row of rows) {
      let doc;
      try {
        doc = JSON.parse(row.doc);
      } catch {
        doc = { id: row.id };
      }
      if (!byCollection[row.collection]) byCollection[row.collection] = [];
      byCollection[row.collection].push(toPaise({ ...doc, id: doc.id || row.id }, row.collection));
      records += 1;
    }
    const settingsRow = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`)
      .bind(`settings:${profile.id}`)
      .first();
    let settings = null;
    if (settingsRow) {
      try {
        settings = JSON.parse(settingsRow.v);
      } catch {
        settings = null;
      }
    }
    profileList.push({ id: profile.id, kind: profile.kind, name: profile.name, role: profile.role, settings });
    data[profile.id] = byCollection;
  }

  const payload = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: String(appVersion || '').slice(0, 40),
    createdAt: new Date().toISOString(),
    moneyUnit: 'paise',
    account: { id: userId, email: includeEmail || '' },
    profiles: profileList,
    data,
    counts: { profiles: profileList.length, records },
  };
  payload.checksum = { algorithm: 'sha256', value: await checksumOf(payload) };
  return payload;
}

export function serialise(payload) {
  return JSON.stringify(payload, null, 2);
}

/** Validate, then merge into the caller's profiles in one transaction. */
export async function restoreExport(env, userId, payload) {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'That file is not a planner backup');
  if (payload.format !== BACKUP_FORMAT) throw new HttpError(400, 'That file is not a planner backup');
  const version = Number(payload.schemaVersion);
  if (!Number.isFinite(version) || version < 1) throw new HttpError(400, 'That backup has no schema version');
  if (version > BACKUP_SCHEMA_VERSION) {
    throw new HttpError(400, 'That backup was made by a newer version of the app. Update the app first.');
  }
  if (payload.moneyUnit !== 'paise') {
    throw new HttpError(400, 'That backup does not declare its money unit, so it cannot be restored safely');
  }
  if (!payload.checksum || payload.checksum.algorithm !== 'sha256') {
    throw new HttpError(400, 'That backup has no checksum');
  }
  const actual = await checksumOf(payload);
  if (actual !== String(payload.checksum.value || '').toLowerCase()) {
    throw new HttpError(400, 'That backup is damaged: its checksum does not match. Restore a different copy.');
  }

  const profiles = await listProfiles(env, userId);
  const allowed = new Set(profiles.map((p) => p.id));
  const spaces = Object.keys(payload.data || {});
  if (!spaces.length) throw new HttpError(400, 'That backup contains no data');
  const foreign = spaces.filter((space) => !allowed.has(space));
  if (foreign.length) {
    throw new HttpError(
      403,
      'That backup belongs to a profile this account cannot write to. Restore it from an account that is a member of it.',
    );
  }

  let rows = 0;
  for (const space of spaces) {
    for (const collection of Object.keys(payload.data[space] || {})) {
      if (!COLLECTIONS[collection]) continue;
      rows += (payload.data[space][collection] || []).length;
    }
  }
  if (!rows) throw new HttpError(400, 'That backup contains no records');
  if (rows > MAX_RESTORE_ROWS) {
    throw new HttpError(413, `That backup holds ${rows} records; one restore is limited to ${MAX_RESTORE_ROWS}. Split it by profile and try again.`);
  }

  const now = Date.now();
  const statements = [];
  const perCollection = {};
  for (const space of spaces) {
    for (const collection of Object.keys(payload.data[space] || {})) {
      if (!COLLECTIONS[collection]) continue;
      const list = payload.data[space][collection] || [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.id || '').slice(0, 80);
        if (!id) continue;
        const doc = fromPaise(entry, collection);
        statements.push(
          env.DB.prepare(
            `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by)
             VALUES (?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(space, collection, id) DO UPDATE SET doc = excluded.doc, rev = records.rev + 1,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          ).bind(space, collection, id, JSON.stringify(doc), now, userId),
        );
        perCollection[collection] = (perCollection[collection] || 0) + 1;
      }
    }
    const settings = (payload.profiles || []).find((p) => p.id === space)?.settings;
    if (settings && typeof settings === 'object') {
      statements.push(
        env.DB.prepare(
          `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        ).bind(`settings:${space}`, JSON.stringify(settings)),
      );
    }
  }

  // One batch is one D1 transaction: a restore either lands completely or not at
  // all, so a failed restore cannot leave half a household behind.
  await env.DB.batch(statements);
  return { records: rows, collections: Object.keys(perCollection).length, perCollection, profiles: spaces.length };
}

/** Names used for stored files; sortable, so "keep the newest N" is a string sort. */
export function backupFilename(date = new Date()) {
  const iso = date.toISOString().replace(/[:.]/g, '-');
  return `family-planner-${iso}.json`;
}

export const CLOUD_PROVIDER_IDS = new Set(Object.keys(CLOUD_PROVIDERS));

/** The stored connection for one account, in the shape the connector expects. */
export async function cloudLink(env, userId, provider) {
  const row = await env.DB.prepare(
    `SELECT provider, refresh_token, access_token, expires_at, last_backup_at FROM cloud_links
      WHERE user_id = ? AND provider = ?`,
  )
    .bind(userId, String(provider || ''))
    .first();
  if (!row) return null;
  return {
    provider: row.provider,
    sealedRefresh: row.refresh_token,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    lastBackupAt: row.last_backup_at,
  };
}

/** Export, upload, record it, then trim the provider to the newest `keep` files. */
export async function runBackup(env, { userId, provider, trigger = 'manual', appVersion = '', fetchImpl = fetch }) {
  const saved = await cloudLink(env, userId, provider);
  if (!saved) throw new HttpError(400, 'Connect that drive first');
  const payload = await buildExport(env, userId, { appVersion });
  const text = serialise(payload);
  const filename = backupFilename();
  await uploadBackup(env, saved, filename, text, fetchImpl);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO backup_runs (id, user_id, provider, filename, sha256, bytes, created_at, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, provider, filename, payload.checksum.value, text.length, Date.now(), trigger),
    env.DB.prepare(`UPDATE cloud_links SET last_backup_at = ? WHERE user_id = ? AND provider = ?`).bind(
      Date.now(),
      userId,
      provider,
    ),
    env.DB.prepare(`UPDATE backup_settings SET last_run_at = ? WHERE user_id = ?`).bind(Date.now(), userId),
  ]);

  const settings = await env.DB.prepare(`SELECT keep FROM backup_settings WHERE user_id = ?`).bind(userId).first();
  const keep = Math.min(60, Math.max(1, Number(settings && settings.keep) || 7));
  let pruned = 0;
  try {
    const files = await listBackups(env, saved, fetchImpl);
    for (const file of files.slice(keep)) {
      await deleteBackup(env, saved, file.id, fetchImpl);
      pruned += 1;
    }
  } catch (err) {
    // A failed prune must not fail the backup that just succeeded.
    console.error('backup prune failed', err && err.message);
  }

  return {
    ok: true,
    provider,
    filename,
    sha256: payload.checksum.value,
    bytes: text.length,
    records: payload.counts.records,
    profiles: payload.counts.profiles,
    pruned,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Cron Trigger entry point. Only accounts that turned automatic backup on are
 * touched, and each one is due at most daily or weekly. One account failing (an
 * expired token, a provider outage) never stops the others.
 */
export async function runScheduledBackups(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const rows = (await env.DB.prepare(
    `SELECT s.user_id, s.provider, s.frequency, s.last_run_at
       FROM backup_settings s
       JOIN cloud_links c ON c.user_id = s.user_id AND c.provider = s.provider
      WHERE s.enabled = 1 AND s.provider IS NOT NULL`,
  ).all()).results || [];

  const results = [];
  for (const row of rows) {
    const period = row.frequency === 'weekly' ? 7 * DAY_MS : DAY_MS;
    if (row.last_run_at && now - Number(row.last_run_at) < period) continue;
    try {
      const out = await runBackup(env, {
        userId: row.user_id,
        provider: row.provider,
        trigger: 'cron',
        appVersion: env.APP_VERSION || '',
        fetchImpl,
      });
      results.push({ userId: row.user_id, ok: true, filename: out.filename });
    } catch (err) {
      console.error('scheduled backup failed', row.user_id, row.provider, err && err.message);
      // Record the attempt so a broken connection does not retry every minute.
      await env.DB.prepare(`UPDATE backup_settings SET last_run_at = ? WHERE user_id = ?`)
        .bind(now, row.user_id)
        .run();
      results.push({ userId: row.user_id, ok: false, error: String((err && err.message) || err).slice(0, 200) });
    }
  }
  return results;
}
