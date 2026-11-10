// A D1-shaped adapter over node:sqlite, for tests that need the real SQL engine
// (foreign keys, cascades, CHECK constraints) without a Worker or a network round
// trip. It implements only the surface the migrations and store use:
// prepare().bind().run()/all()/first() and batch(), which runs in a transaction
// just like D1.

import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params.map((p) => (p === undefined ? null : p));
    return this;
  }

  // D1's API is asynchronous; the adapter keeps that shape so code under test
  // does not have to know whether it is talking to SQLite or to D1.
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }

  /**
   * D1's batch returns rows for a SELECT, so reading statements must go through
   * all() here. Running a SELECT through run() silently answered no rows, which
   * made anything built on a batched read (getState does six of them) look empty.
   */
  runForBatch() {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(select|pragma|with)\b/i.test(this.sql)) {
      return { success: true, results: statement.all(...this.params) };
    }
    const info = statement.run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

export function makeDatabase(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  const DB = {
    prepare: (sql) => new Statement(db, sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.runForBatch());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    exec: (sql) => db.exec(sql),
    all: (sql) => db.prepare(sql).all(),
    get: (sql) => db.prepare(sql).get(sql) ?? null,
  };
  return { db, env: { DB } };
}

/** Read one value with a bound-free query: tests only. */
export function scalar(db, sql) {
  const row = db.prepare(sql).get();
  return row ? Object.values(row)[0] : null;
}
