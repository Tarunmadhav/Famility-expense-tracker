// The schema is the part of this app that cannot be fixed with a deploy, so it
// gets the strictest tests: the migration chain must apply to an empty database,
// must upgrade the v12 shape without losing a row, and must leave real
// constraints behind.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyMigrations, migrationState, pendingMigrations } from '../src/migrations/runner.js';
import { makeDatabase, scalar } from './helpers/d1.mjs';

const LEGACY = readFileSync(new URL('./fixtures/legacy-v12.sql', import.meta.url), 'utf8');

async function freshDatabase() {
  const { db, env } = makeDatabase();
  const applied = await applyMigrations(env);
  return { db, env, applied };
}

test('migrations apply to an empty database and are recorded once', async () => {
  const { db, env, applied } = await freshDatabase();
  assert.deepEqual(applied, ['0001_baseline', '0002_constraints']);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM schema_migrations`), 2);
  // Running again is a no-op: the bookkeeping row stops a second application.
  assert.deepEqual(await pendingMigrations(env), []);
  assert.deepEqual(await applyMigrations(env), []);
  const state = await migrationState(env);
  assert.deepEqual(state.pending, []);
  assert.equal(state.latest, '0002_constraints');
});

test('the rebuilt tables carry real foreign keys', async () => {
  const { db } = await freshDatabase();
  db.prepare(`INSERT INTO users (id, name, iterations, created_at, role) VALUES ('u1', 'Owner', 100000, 1, 'owner')`).run();
  // A session for an account that does not exist is rejected by SQLite itself,
  // not only by application code.
  assert.throws(
    () => db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'ghost', 1, 2)`).run(),
    /FOREIGN KEY constraint failed/,
  );
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'u1', 1, 2)`).run();
  // Deleting the account takes its sessions with it.
  db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();
  assert.equal(scalar(db, `SELECT COUNT(*) FROM sessions`), 0);
});

test('unique email and role checks are enforced by the database', async () => {
  const { db } = await freshDatabase();
  db.prepare(`INSERT INTO users (id, name, iterations, created_at, role) VALUES ('u1', 'A', 100000, 1, 'owner')`).run();
  db.prepare(`INSERT INTO users (id, name, iterations, created_at, role) VALUES ('u2', 'B', 100000, 2, 'member')`).run();
  db.prepare(`INSERT INTO credentials (user_id, email, iterations, created_at) VALUES ('u1', 'a@example.com', 100000, 1)`).run();
  // One address, one account.
  assert.throws(
    () => db.prepare(`INSERT INTO credentials (user_id, email, iterations, created_at) VALUES ('u2', 'a@example.com', 100000, 2)`).run(),
    /UNIQUE constraint failed/,
  );
  // `users` keeps its invariants through triggers, because rebuilding it would
  // cascade into every table that points at it.
  assert.throws(
    () => db.prepare(`INSERT INTO users (id, name, iterations, created_at, role) VALUES ('u3', 'C', 100000, 3, 'wizard')`).run(),
    /users.role must be owner or member/,
  );
  assert.throws(() => db.prepare(`UPDATE users SET role = 'root' WHERE id = 'u1'`).run(), /users.role must be/);
});

test('the query indexes the API depends on exist', async () => {
  const { db } = await freshDatabase();
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name);
  for (const expected of [
    'sessions_user_idx',
    'records_updated_idx',
    'notifications_unread_idx',
    'oauth_links_user_idx',
    'profile_members_user_idx',
    'files_record_idx',
    'audit_log_actor_idx',
    'backup_runs_user_idx',
  ]) {
    assert.ok(names.includes(expected), `missing index ${expected}`);
  }
});

test('a v12 database upgrades without losing rows and sheds dangling references', async () => {
  const { db, env } = makeDatabase();
  db.exec(LEGACY);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM sessions`), 2);

  const applied = await applyMigrations(env);
  assert.deepEqual(applied, ['0001_baseline', '0002_constraints']);

  // Everything that pointed at a real account survived.
  assert.equal(scalar(db, `SELECT COUNT(*) FROM users`), 2);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM credentials`), 2);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM sessions`), 1);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM oauth_links`), 1);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM records`), 1);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM files`), 1);
  // The member's row for the family profile survived the profiles rebuild.
  assert.equal(scalar(db, `SELECT COUNT(*) FROM profile_members WHERE profile_id = 'p-family'`), 1);
  // Dangling rows are gone: a session and an oauth link for a deleted account,
  // a membership of a profile that never existed.
  assert.equal(scalar(db, `SELECT COUNT(*) FROM sessions WHERE user_id = 'u-ghost'`), 0);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM profile_members WHERE user_id = 'u-ghost'`), 0);
  // A file whose uploader is gone keeps the file and clears the attribution.
  assert.equal(scalar(db, `SELECT uploaded_by FROM files WHERE id = 'f1'`), null);
  // The old rows are kept as a rollback snapshot for one release.
  assert.equal(scalar(db, `SELECT COUNT(*) FROM profiles_legacy_v12`), 1);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM profile_members_legacy_v12`), 1);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
});

test('the legacy password hash of a PIN-only account is preserved verbatim', async () => {
  const { db, env } = makeDatabase();
  db.exec(LEGACY);
  await applyMigrations(env);
  const row = db.prepare(`SELECT email, password_hash FROM credentials WHERE user_id = 'u-member'`).get();
  // An empty hash means "provider/PIN owns this account", and that must not be
  // turned into a working password by the migration.
  assert.equal(row.email, 'member@example.com');
  assert.equal(row.password_hash, '');
});
