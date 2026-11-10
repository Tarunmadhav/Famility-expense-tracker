// The schema gate: ensureSchema must apply a migration that was added after the
// meta version row was written. Gating on the version alone would leave every
// existing deployment on the old schema for ever, which is exactly what happened
// to the calendar feed table before this test existed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIGRATIONS } from '../src/migrations/index.js';
import { applyMigrations } from '../src/migrations/runner.js';
import { SCHEMA_VERSION, ensureSchema } from '../src/store.js';
import { makeDatabase, scalar } from './helpers/d1.mjs';

test('a migration added after the version row still runs', async () => {
  const { db, env } = makeDatabase();
  await applyMigrations(env);
  // Pretend the chain ran, then a new migration appeared: drop its bookkeeping
  // row and its table while meta still records the current version.
  // Pick a migration that creates something checkable, not just a data repair.
  const target = MIGRATIONS.find((m) => m.id === '0003_calendar_feed');
  assert.ok(target, 'the calendar feed migration is missing');
  const last = target;
  db.prepare(`DELETE FROM schema_migrations WHERE id = ?`).run(last.id);
  db.exec('DROP TABLE IF EXISTS calendar_feeds');
  db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(SCHEMA_VERSION);
  assert.equal(scalar(db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='calendar_feeds'`), 0);
  assert.equal(scalar(db, `SELECT v FROM meta WHERE k = 'schema'`), SCHEMA_VERSION);

  await ensureSchema(env);

  assert.equal(
    scalar(db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='calendar_feeds'`),
    1,
    'ensureSchema skipped the new migration because the version row was already current',
  );
  assert.equal(scalar(db, `SELECT COUNT(*) FROM schema_migrations WHERE id = ?`.replace('?', `'${last.id}'`)), 1);
});
