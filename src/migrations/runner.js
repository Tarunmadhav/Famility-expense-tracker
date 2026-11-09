// Applies the ordered migrations in ./index.js exactly once each.
//
// The applied ids live in D1 (`schema_migrations`), so any number of Worker
// isolates can run this concurrently: two of them racing on the same migration
// end with the same rows, because the batch that changes the schema also inserts
// the bookkeeping row and a duplicate id is a no-op (`INSERT OR IGNORE`).

import { MIGRATIONS } from './index.js';

const TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

async function appliedIds(env) {
  const rows = (await env.DB.prepare(`SELECT id FROM schema_migrations`).all()).results || [];
  return new Set(rows.map((r) => r.id));
}

export async function pendingMigrations(env) {
  await env.DB.prepare(TABLE).run();
  const done = await appliedIds(env);
  return MIGRATIONS.filter((m) => !done.has(m.id));
}

/**
 * Run every migration that has not been applied yet.
 * Returns the ids that were applied by this call.
 */
export async function applyMigrations(env, log = () => {}) {
  const pending = await pendingMigrations(env);
  const applied = [];
  for (const migration of pending) {
    if (typeof migration.before === 'function') await migration.before(env);
    log('migrate:start', migration.id);
    const sql = typeof migration.statements === 'function' ? migration.statements() : migration.statements;
    await env.DB.batch(sql.map((statement) => env.DB.prepare(statement)));
    if (typeof migration.after === 'function') await migration.after(env);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)`,
    )
      .bind(migration.id, migration.name || migration.id, Date.now())
      .run();
    applied.push(migration.id);
    log('migrate:done', migration.id);
  }
  return applied;
}

export async function migrationState(env) {
  await env.DB.prepare(TABLE).run();
  const rows = (await env.DB.prepare(`SELECT id, name, applied_at FROM schema_migrations ORDER BY id`).all()).results || [];
  const done = new Set(rows.map((r) => r.id));
  return {
    applied: rows,
    pending: MIGRATIONS.filter((m) => !done.has(m.id)).map((m) => m.id),
    latest: MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].id : null,
  };
}
