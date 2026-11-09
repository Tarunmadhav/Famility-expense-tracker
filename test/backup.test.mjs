// Backup: the crypto that protects a stored drive token, the export format, and
// the restore that has to be all-or-nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKUP_SCHEMA_VERSION,
  buildExport,
  checksumOf,
  fromPaise,
  restoreExport,
  runScheduledBackups,
  serialise,
  toPaise,
} from '../src/backup.js';
import { openToken, sealToken } from '../src/backupcrypto.js';
import { applyMigrations } from '../src/migrations/runner.js';
import { ensureProfiles } from '../src/profiles.js';
import { listProfiles } from '../src/profiles.js';
import { makeDatabase } from './helpers/d1.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function seededAccount() {
  const { db, env } = makeDatabase();
  await applyMigrations(env);
  env.BACKUP_KEY = KEY;
  env.APP_VERSION = 'test';
  env.GOOGLE_CLIENT_ID = 'google-id';
  env.GOOGLE_CLIENT_SECRET = 'google-secret';
  await env.DB.prepare(
    `INSERT INTO users (id, name, iterations, created_at, role, household) VALUES ('u1', 'Owner', 100000, 1, 'owner', 'h:u1')`,
  ).run();
  await ensureProfiles(env);
  const profiles = await listProfiles(env, 'u1');
  const space = profiles[0].id;
  await env.DB.prepare(
    `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by)
     VALUES (?, 'expenses', 'e1', ?, 1, 1, 'u1')`,
  )
    .bind(space, JSON.stringify({ id: 'e1', title: 'Rent', amount: 1250.5, date: '2026-11-01' }))
    .run();
  return { db, env, profiles, space };
}

test('a refresh token is sealed with AES-GCM and only that key opens it', async () => {
  const env = { BACKUP_KEY: KEY };
  const sealed = await sealToken(env, 'refresh-token-value');
  assert.ok(sealed.startsWith('v1.'));
  assert.ok(!sealed.includes('refresh-token-value'), 'the token must not be readable in the stored value');
  assert.equal(await openToken(env, sealed), 'refresh-token-value');

  await assert.rejects(() => openToken({ BACKUP_KEY: OTHER_KEY }, sealed), /could not be decrypted/);
  const tampered = `${sealed.slice(0, -4)}AAAA`;
  await assert.rejects(() => openToken(env, tampered), /could not be decrypted/);
  await assert.rejects(() => openToken({ BACKUP_KEY: 'not-32-bytes' }, sealed), /32 bytes/);
});

test('money is exported as integer paise and restored as the stored shape', () => {
  const doc = { id: 'e1', amount: 1250.5, emi: 0, title: 'Rent' };
  const exported = toPaise(doc, 'expenses');
  assert.equal(exported.amount, 125050);
  assert.ok(Number.isInteger(exported.amount));
  assert.equal(exported.title, 'Rent');
  const back = fromPaise(exported, 'expenses');
  assert.equal(back.amount, 1250.5);
  // A collection without money fields is untouched.
  assert.deepEqual(toPaise({ id: 'c1', name: 'Ann' }, 'contacts'), { id: 'c1', name: 'Ann' });
});

test('the export declares its schema, unit and checksum, and the checksum covers the data', async () => {
  const { env } = await seededAccount();
  const payload = await buildExport(env, 'u1', { appVersion: 'test' });
  assert.equal(payload.format, 'ffp-backup');
  assert.equal(payload.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.equal(payload.moneyUnit, 'paise');
  assert.ok(payload.createdAt);
  assert.equal(payload.checksum.algorithm, 'sha256');
  assert.equal(await checksumOf(payload), payload.checksum.value);

  // Editing a record invalidates the checksum.
  const copy = JSON.parse(serialise(payload));
  copy.data[payload.profiles[0].id].expenses[0].amount = 1;
  assert.notEqual(await checksumOf(copy), payload.checksum.value);
});

test('restore merges by id inside one transaction, converting paise back', async () => {
  const { db, env, profiles } = await seededAccount();
  const payload = await buildExport(env, 'u1', { appVersion: 'test' });

  // A second, new record arrives in the backup, and the existing one changed.
  const space = profiles[0].id;
  payload.data[space].expenses[0].amount = 99900;
  payload.data[space].expenses.push({ id: 'e2', title: 'Power', amount: 48000, date: '2026-11-02' });
  payload.checksum.value = await checksumOf(payload);

  const stats = await restoreExport(env, 'u1', payload);
  assert.equal(stats.records, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM records`).get().n, 2);
  const row = db.prepare(`SELECT doc, rev FROM records WHERE id = 'e1'`).get();
  assert.equal(JSON.parse(row.doc).amount, 999, 'paise must be converted back to rupees');
  assert.equal(row.rev, 2, 'a replaced row must advance its revision');
  const added = db.prepare(`SELECT doc FROM records WHERE id = 'e2'`).get();
  assert.equal(JSON.parse(added.doc).amount, 480);
});

test('a damaged or foreign backup is refused', async () => {
  const { env } = await seededAccount();
  const payload = await buildExport(env, 'u1', { appVersion: 'test' });

  const damaged = JSON.parse(serialise(payload));
  damaged.data[payload.profiles[0].id].expenses[0].title = 'Tampered';
  await assert.rejects(() => restoreExport(env, 'u1', damaged), /checksum does not match/);

  const foreign = JSON.parse(serialise(payload));
  foreign.data['h:someone-else'] = { expenses: [{ id: 'x1', amount: 100 }] };
  foreign.checksum.value = await checksumOf(foreign);
  await assert.rejects(() => restoreExport(env, 'u1', foreign), /profile this account cannot write to/);

  const wrongUnit = JSON.parse(serialise(payload));
  wrongUnit.moneyUnit = 'rupees';
  await assert.rejects(() => restoreExport(env, 'u1', wrongUnit), /money unit/);

  const future = JSON.parse(serialise(payload));
  future.schemaVersion = BACKUP_SCHEMA_VERSION + 1;
  await assert.rejects(() => restoreExport(env, 'u1', future), /newer version/);

  assert.equal(await checksumOf(payload), payload.checksum.value, 'the original must still verify');
});

test('the scheduled run respects the schedule, encrypts nothing on the wire, and prunes', async () => {
  const { env, db } = await seededAccount();
  const sealed = await sealToken(env, 'refresh-value');
  await env.DB.prepare(
    `INSERT INTO cloud_links (user_id, provider, refresh_token, access_token, expires_at, created_at)
     VALUES ('u1', 'google', ?, '', 0, 1)`,
  )
    .bind(sealed)
    .run();
  await env.DB.prepare(
    `INSERT INTO backup_settings (user_id, provider, enabled, frequency, keep, updated_at)
     VALUES ('u1', 'google', 1, 'daily', 2, 1)`,
  ).run();

  const calls = [];
  let existing = [
    { id: 'a', name: 'family-planner-old-1.json', createdTime: new Date(Date.now() - 3000).toISOString() },
    { id: 'b', name: 'family-planner-old-2.json', createdTime: new Date(Date.now() - 2000).toISOString() },
    { id: 'c', name: 'family-planner-old-3.json', createdTime: new Date(Date.now() - 1000).toISOString() },
  ];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET' });
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'fresh', expires_in: 3600 });
    if (u.includes('upload/drive')) return json({ id: 'new-file' });
    if (u.includes('/files?spaces=appdata')) {
      return json({
        files: [
          { id: 'new-file', name: 'family-planner-new.json', createdTime: new Date().toISOString(), size: '1000' },
          ...existing,
        ],
      });
    }
    if ((options.method || 'GET') === 'DELETE') {
      existing = existing.filter((f) => !u.includes(f.id));
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    }
    return json({});
  };

  const first = await runScheduledBackups(env, { now: Date.now(), fetchImpl });
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, true);
  // The refresh token was decrypted to ask for an access token, not sent as-is.
  const tokenCall = calls.find((c) => c.url.includes('token'));
  assert.ok(tokenCall, 'the refresh token must be used to get an access token');
  // Keep 2: the three old files plus the new one -> two deletions.
  const deletes = calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM backup_runs`).get().n, 1);
  assert.ok(db.prepare(`SELECT last_run_at FROM backup_settings WHERE user_id = 'u1'`).get().last_run_at > 0);

  // A second run the same day is not due.
  calls.length = 0;
  const second = await runScheduledBackups(env, { now: Date.now() + 60_000, fetchImpl });
  assert.deepEqual(second, []);
  assert.equal(calls.length, 0);
});
