// Versioned schema migrations.
//
// Every change to the database is an ordered entry here. The runner records each
// applied id in `schema_migrations` and never re-runs one, so deploying a new
// migration is a normal deploy: no manual SQL, no hand-edited tables.
//
// Rules for adding an entry:
//   - never edit an applied migration; add a new one
//   - keep the id monotonic (`0007_something`)
//   - a batch runs inside one transaction, so a migration is all-or-nothing
//
// 0001 is the baseline that also runs on a brand-new database. 0002 rebuilds the
// tables created before constraints existed (SQLite cannot ALTER a table into
// having foreign keys, so the rows are copied into a table that has them).

const USERS = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL DEFAULT '',
  pin_salt TEXT NOT NULL DEFAULT '',
  iterations INTEGER NOT NULL CHECK (iterations > 0),
  created_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  household TEXT NOT NULL DEFAULT 'family',
  recovery_hash TEXT,
  recovery_salt TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;

const CREDENTIALS = `CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL DEFAULT '',
  iterations INTEGER NOT NULL DEFAULT 100000 CHECK (iterations > 0),
  created_at INTEGER NOT NULL
)`;

const SESSIONS = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT,
  ip TEXT
)`;

const OAUTH_LINKS = `CREATE TABLE IF NOT EXISTS oauth_links (
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id)
)`;

const CLOUD_LINKS = `CREATE TABLE IF NOT EXISTS cloud_links (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'onedrive')),
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_backup_at INTEGER,
  PRIMARY KEY (user_id, provider)
)`;

const PROFILES = `CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'family' CHECK (kind IN ('family', 'personal', 'office')),
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
)`;

const PROFILE_MEMBERS = `CREATE TABLE IF NOT EXISTS profile_members (
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor', 'owner')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, user_id)
)`;

const FILES = `CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL DEFAULT 'family',
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  key TEXT NOT NULL UNIQUE,
  collection TEXT,
  record_id TEXT,
  uploaded_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
)`;

const PUSH_SUBS = `CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ua TEXT,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE
)`;

const WHATSAPP_LINKS = `CREATE TABLE IF NOT EXISTS whatsapp_links (
  phone TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile TEXT,
  created_at INTEGER NOT NULL
)`;

const BACKUP_SETTINGS = `CREATE TABLE IF NOT EXISTS backup_settings (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT CHECK (provider IS NULL OR provider IN ('google', 'onedrive')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
  keep INTEGER NOT NULL DEFAULT 7 CHECK (keep BETWEEN 1 AND 60),
  last_run_at INTEGER,
  updated_at INTEGER NOT NULL
)`;

const BACKUP_RUNS = `CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'onedrive')),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  created_at INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'cron', 'restore'))
)`;

/**
 * Copy a legacy table into its constrained replacement. The old rows are kept as
 * a plain `<name>_legacy_v12` snapshot for one release, so a bad deploy can be
 * rolled back by copying them back.
 *
 * The snapshot is made with CREATE TABLE ... AS SELECT rather than RENAME: a
 * rename rewrites the foreign keys of every table that points at the renamed
 * one, which would leave the children pointing at the snapshot instead of the
 * live table.
 */
function rebuild(name, createSql, columns, copySql) {
  const list = columns.join(', ');
  return [
    `DROP TABLE IF EXISTS ${name}_new`,
    `DROP TABLE IF EXISTS ${name}_legacy_v12`,
    createSql.replace(`CREATE TABLE IF NOT EXISTS ${name} (`, `CREATE TABLE ${name}_new (`),
    `INSERT INTO ${name}_new (${list}) ${copySql}`,
    `CREATE TABLE ${name}_legacy_v12 AS SELECT * FROM ${name}`,
    `DROP TABLE ${name}`,
    `ALTER TABLE ${name}_new RENAME TO ${name}`,
  ];
}

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)`,
  `CREATE INDEX IF NOT EXISTS records_rev_idx ON records (space, rev)`,
  `CREATE INDEX IF NOT EXISTS records_collection_idx ON records (space, collection)`,
  `CREATE INDEX IF NOT EXISTS records_updated_idx ON records (space, collection, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS changes_space_idx ON changes (space, seq)`,
  `CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (space, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (space, read_at)`,
  `CREATE INDEX IF NOT EXISTS auth_fails_idx ON auth_fails (ip, ts)`,
  `CREATE INDEX IF NOT EXISTS oauth_links_user_idx ON oauth_links (user_id)`,
  `CREATE INDEX IF NOT EXISTS profile_members_user_idx ON profile_members (user_id)`,
  `CREATE INDEX IF NOT EXISTS profiles_owner_idx ON profiles (owner_id)`,
  `CREATE INDEX IF NOT EXISTS files_created_idx ON files (space, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS files_record_idx ON files (space, collection, record_id)`,
  `CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_log_profile_idx ON audit_log (profile_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS backup_runs_user_idx ON backup_runs (user_id, created_at DESC)`,
];

// Columns added after the first release. They are topped up before 0002 copies
// rows, so an older database still ends up with the full column set.
const LATE_COLUMNS = [
  ['users', 'role', `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`],
  ['users', 'household', `ALTER TABLE users ADD COLUMN household TEXT NOT NULL DEFAULT 'family'`],
  ['users', 'recovery_hash', 'ALTER TABLE users ADD COLUMN recovery_hash TEXT'],
  ['users', 'recovery_salt', 'ALTER TABLE users ADD COLUMN recovery_salt TEXT'],
  ['users', 'totp_secret', 'ALTER TABLE users ADD COLUMN totp_secret TEXT'],
  ['users', 'totp_enabled', 'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0'],
  ['users', 'totp_last_step', 'ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0'],
  ['users', 'updated_at', 'ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0'],
  ['oauth_links', 'email', 'ALTER TABLE oauth_links ADD COLUMN email TEXT'],
  ['cloud_links', 'last_backup_at', 'ALTER TABLE cloud_links ADD COLUMN last_backup_at INTEGER'],
  ['push_subs', 'user_id', 'ALTER TABLE push_subs ADD COLUMN user_id TEXT'],
  ['ai_connections', 'profile_id', 'ALTER TABLE ai_connections ADD COLUMN profile_id TEXT'],
];

export const MIGRATIONS = [
  {
    id: '0001_baseline',
    name: 'baseline schema',
    statements: [
        `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
        USERS,
        SESSIONS,
        `CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL DEFAULT 'family', collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (space, collection, id))`,
        `CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL DEFAULT 'family', collection TEXT NOT NULL, record_id TEXT NOT NULL, op TEXT NOT NULL, actor TEXT, ts INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, space TEXT NOT NULL DEFAULT 'family', type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', collection TEXT, record_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER, dedupe TEXT UNIQUE)`,
        PUSH_SUBS,
        `CREATE TABLE IF NOT EXISTS auth_fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
        CREDENTIALS,
        `CREATE TABLE IF NOT EXISTS email_otps (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
        OAUTH_LINKS,
        CLOUD_LINKS,
        `CREATE TABLE IF NOT EXISTS whatsapp_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, profile TEXT, expires_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS whatsapp_state (phone TEXT PRIMARY KEY, collection TEXT, ids TEXT, updated_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS whatsapp_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
        WHATSAPP_LINKS,
        FILES,
        `CREATE TABLE IF NOT EXISTS ai_connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, profile_id TEXT)`,
        `CREATE TABLE IF NOT EXISTS family_invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER, household TEXT NOT NULL DEFAULT 'family')`,
        `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)`,
        PROFILES,
        PROFILE_MEMBERS,
        `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, profile_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT)`,
    ],
  },
  {
    id: '0002_constraints',
    name: 'foreign keys, checks and query indexes',
    async before(env) {
      // Older databases may predate some columns; add them so the copy below has
      // a complete column list on every install.
      for (const [table, column, ddl] of LATE_COLUMNS) {
        const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all().catch(() => ({ results: [] }));
        const present = (info.results || []).some((c) => c.name === column);
        if (!present) await env.DB.prepare(ddl).run().catch(() => {});
      }
      // Dangling rows cannot satisfy the new foreign keys and are unusable
      // anyway (their account no longer exists). They are removed before the
      // tables are rebuilt so the migration cannot fail on real data.
      const cleanup = [
        `DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)`,
        `DELETE FROM oauth_links WHERE user_id NOT IN (SELECT id FROM users)`,
        `DELETE FROM cloud_links WHERE user_id NOT IN (SELECT id FROM users)`,
        `DELETE FROM push_subs WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)`,
        `DELETE FROM whatsapp_links WHERE user_id NOT IN (SELECT id FROM users)`,
        `DELETE FROM profile_members WHERE user_id NOT IN (SELECT id FROM users) OR profile_id NOT IN (SELECT id FROM profiles)`,
        `DELETE FROM profiles WHERE owner_id NOT IN (SELECT id FROM users)`,
        `UPDATE files SET uploaded_by = NULL WHERE uploaded_by IS NOT NULL AND uploaded_by NOT IN (SELECT id FROM users)`,
        `UPDATE credentials SET email = lower(trim(email)) WHERE email IS NOT NULL AND email <> lower(trim(email))`,
      ];
      await env.DB.batch(cleanup.map((sql) => env.DB.prepare(sql)));
    },
    statements() {
      return [
        // Foreign key checks are deferred until the batch commits, which lets
        // each table be replaced while the others still reference it.
        `PRAGMA defer_foreign_keys = ON`,
        // `profiles` is a parent of `profile_members`, and DROP TABLE cascades
        // into children even with deferred checks. The members are parked in a
        // plain snapshot table first (no foreign keys, so the drop cannot reach
        // it) and restored below, once the new `profiles` exists.
        `DROP TABLE IF EXISTS profile_members_snapshot`,
        `CREATE TABLE profile_members_snapshot AS SELECT * FROM profile_members`,
        ...rebuild('profiles', PROFILES, ['id', 'kind', 'name', 'owner_id', 'created_at'],
          `SELECT id, kind, name, owner_id, created_at FROM profiles`),
        // profile_members, restored from the snapshot. The snapshot itself is
        // kept as the rollback copy, because the old table is already empty.
        `DROP TABLE IF EXISTS profile_members_new`,
        PROFILE_MEMBERS.replace('CREATE TABLE IF NOT EXISTS profile_members (', 'CREATE TABLE profile_members_new ('),
        `INSERT INTO profile_members_new (profile_id, user_id, role, created_at)
           SELECT profile_id, user_id, role, created_at FROM profile_members_snapshot
           WHERE profile_id IN (SELECT id FROM profiles) AND user_id IN (SELECT id FROM users)`,
        `DROP TABLE IF EXISTS profile_members_legacy_v12`,
        `DROP TABLE IF EXISTS profile_members`,
        `ALTER TABLE profile_members_new RENAME TO profile_members`,
        `ALTER TABLE profile_members_snapshot RENAME TO profile_members_legacy_v12`,
        ...rebuild('credentials', CREDENTIALS, ['user_id', 'email', 'password_hash', 'password_salt', 'iterations', 'created_at'],
          `SELECT user_id, coalesce(nullif(trim(email), ''), 'unnamed+' || user_id || '@invalid.local'), coalesce(password_hash, ''), coalesce(password_salt, ''), coalesce(iterations, 100000), created_at FROM credentials`),
        ...rebuild('sessions', SESSIONS, ['id', 'user_id', 'created_at', 'expires_at', 'ua', 'ip'],
          `SELECT id, user_id, created_at, expires_at, ua, ip FROM sessions`),
        ...rebuild('oauth_links', OAUTH_LINKS, ['provider', 'provider_id', 'user_id', 'email', 'created_at'],
          `SELECT provider, provider_id, user_id, email, created_at FROM oauth_links`),
        ...rebuild('cloud_links', CLOUD_LINKS, ['user_id', 'provider', 'refresh_token', 'access_token', 'expires_at', 'created_at', 'last_backup_at'],
          `SELECT user_id, provider, coalesce(refresh_token, ''), access_token, expires_at, created_at, last_backup_at FROM cloud_links`),
        ...rebuild('files', FILES, ['id', 'space', 'name', 'mime', 'size', 'key', 'collection', 'record_id', 'uploaded_by', 'created_at'],
          `SELECT id, space, name, mime, size, key, collection, record_id, uploaded_by, created_at FROM files`),
        ...rebuild('push_subs', PUSH_SUBS, ['id', 'endpoint', 'p256dh', 'auth', 'created_at', 'ua', 'user_id'],
          `SELECT id, endpoint, p256dh, auth, created_at, ua, user_id FROM push_subs`),
        ...rebuild('whatsapp_links', WHATSAPP_LINKS, ['phone', 'user_id', 'profile', 'created_at'],
          `SELECT phone, user_id, profile, created_at FROM whatsapp_links`),
        // `users` is deliberately not rebuilt: every other table cascades from
        // it, so dropping it would delete the rows this migration just copied.
        // Its column-level invariants are enforced with triggers instead.
        `CREATE TRIGGER IF NOT EXISTS users_role_insert BEFORE INSERT ON users
           WHEN NEW.role NOT IN ('owner', 'member')
           BEGIN SELECT RAISE(ABORT, 'users.role must be owner or member'); END`,
        `CREATE TRIGGER IF NOT EXISTS users_role_update BEFORE UPDATE OF role ON users
           WHEN NEW.role NOT IN ('owner', 'member')
           BEGIN SELECT RAISE(ABORT, 'users.role must be owner or member'); END`,
        `CREATE TRIGGER IF NOT EXISTS users_totp_insert BEFORE INSERT ON users
           WHEN NEW.totp_enabled NOT IN (0, 1)
           BEGIN SELECT RAISE(ABORT, 'users.totp_enabled must be 0 or 1'); END`,
        `CREATE TRIGGER IF NOT EXISTS users_totp_update BEFORE UPDATE OF totp_enabled ON users
           WHEN NEW.totp_enabled NOT IN (0, 1)
           BEGIN SELECT RAISE(ABORT, 'users.totp_enabled must be 0 or 1'); END`,
        `CREATE TRIGGER IF NOT EXISTS users_iterations_insert BEFORE INSERT ON users
           WHEN NEW.iterations <= 0
           BEGIN SELECT RAISE(ABORT, 'users.iterations must be positive'); END`,
        BACKUP_SETTINGS,
        BACKUP_RUNS,
        ...INDEXES,
      ];
    },
    // A rebuild that would have dropped rows must fail the deploy loudly rather
    // than leave the app running on a half-migrated table.
    async after(env) {
      const fk = await env.DB.prepare(`PRAGMA foreign_key_check`).all();
      if ((fk.results || []).length) {
        throw new Error(`foreign key check failed after migration: ${JSON.stringify(fk.results.slice(0, 5))}`);
      }
    },
  },
  {
    id: '0003_calendar_feed',
    name: 'calendar subscription tokens',
    statements: [
      // One secret URL per account. A calendar client never sends a cookie, so the
      // token is the credential; deleting the row revokes the subscription.
      `CREATE TABLE IF NOT EXISTS calendar_feeds (
        user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE CHECK (length(token) = 48),
        created_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    id: '0004_calendar_feed_profile',
    name: 'one calendar feed per book',
    statements: [
      // A token used to show every book the account could open, so subscribing in
      // a calendar leaked the private book into a shared calendar. The token is
      // now bound to one profile. SQLite cannot change a primary key in place, so
      // the table is rebuilt; existing tokens move to the account's family book,
      // which is what they were mostly showing anyway.
      `CREATE TABLE IF NOT EXISTS calendar_feeds_v2 (
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE CHECK (length(token) = 48),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, profile_id)
      )`,
      `INSERT OR IGNORE INTO calendar_feeds_v2 (user_id, profile_id, token, created_at)
        SELECT f.user_id,
               COALESCE((SELECT p.id FROM profiles p
                           JOIN profile_members m ON m.profile_id = p.id
                          WHERE m.user_id = f.user_id AND p.kind = 'family'
                          ORDER BY p.created_at LIMIT 1), '') ,
               f.token, f.created_at
          FROM calendar_feeds f`,
      `DROP TABLE calendar_feeds`,
      `ALTER TABLE calendar_feeds_v2 RENAME TO calendar_feeds`,
    ],
  },
  {
    id: '0005_clear_seeded_mobile',
    name: 'drop the phone number the starter data used to write',
    // The starter data set settings.mobile to a sample number, and that number
    // then sat in Settings looking as if the account holder had typed it. New
    // seed data leaves the field empty; this clears the value older accounts were
    // given. Only the exact seeded string is touched — a number someone typed,
    // even the same digits in another format, is left alone.
    statements: [`SELECT 1`],
    async after(env) {
      const SEEDED = '+91 8985800099';
      const rows = await env.DB.prepare(`SELECT k, v FROM meta WHERE k LIKE 'settings:%'`).all();
      for (const row of rows.results || []) {
        let parsed;
        try {
          parsed = JSON.parse(row.v);
        } catch {
          continue;
        }
        if (!parsed || parsed.mobile !== SEEDED) continue;
        parsed.mobile = '';
        await env.DB.prepare(`UPDATE meta SET v = ? WHERE k = ?`).bind(JSON.stringify(parsed), row.k).run();
      }
    },
  },
];
