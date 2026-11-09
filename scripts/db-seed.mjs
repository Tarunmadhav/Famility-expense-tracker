#!/usr/bin/env node
// Seed a development database with one household and the sample records the app
// ships with, so a fresh clone has something to look at without setting up an
// account through the UI.
//
//   npm run db:seed                       # local D1 (.wrangler/state)
//   npm run db:seed -- --persist-to .tmp/dev
//   npm run db:seed -- --remote --yes-really
//
// Production is refused unless --remote is passed together with
// --yes-really, because seeding writes an account with a known password.

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { SEED, SETTINGS } from '../src/seed.js';
import { COLLECTION_NAMES } from '../web/src/entities.js';
import { MIGRATIONS } from '../src/migrations/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const remote = flag('remote');
if (remote && !flag('yes-really')) {
  console.error('Refusing to seed a remote database. Add --yes-really if you are sure.');
  process.exit(1);
}

const email = String(value('email', 'seed@example.com')).trim().toLowerCase();
const password = String(value('password', 'SeedPass123'));
const name = String(value('name', 'Seed Owner'));
const persistTo = value('persist-to', null);
const ITERATIONS = 100000;

// Same derivation as src/store.js derivePin: PBKDF2-SHA-256, 256 bits, base64.
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('base64');
const userId = 'seed-owner';
const now = Date.now();

const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
const statements = [];

statements.push(
  `INSERT INTO users (id, name, pin_hash, pin_salt, iterations, created_at, role, household, updated_at)
   VALUES (${esc(userId)}, ${esc(name)}, '', '', ${ITERATIONS}, ${now}, 'owner', 'family', ${now})
   ON CONFLICT(id) DO NOTHING;`,
);
statements.push(
  `INSERT INTO credentials (user_id, email, password_hash, password_salt, iterations, created_at)
   VALUES (${esc(userId)}, ${esc(email)}, ${esc(hash)}, ${esc(salt.toString('base64'))}, ${ITERATIONS}, ${now})
   ON CONFLICT(user_id) DO NOTHING;`,
);
statements.push(
  `INSERT INTO meta (k, v) VALUES ('settings:family', ${esc(JSON.stringify(SETTINGS))})
   ON CONFLICT(k) DO NOTHING;`,
);

let rows = 0;
for (const collection of COLLECTION_NAMES) {
  const list = Array.isArray(SEED[collection]) ? SEED[collection] : [];
  list.forEach((doc, index) => {
    const id = `seed-${collection}-${index + 1}`;
    const body = JSON.stringify({ id, ...doc });
    statements.push(
      `INSERT INTO records (space, collection, id, doc, rev, updated_at, updated_by)
       VALUES ('family', ${esc(collection)}, ${esc(id)}, ${esc(body)}, 1, ${now}, ${esc(userId)})
       ON CONFLICT(space, collection, id) DO NOTHING;`,
    );
    rows += 1;
  });
}

const target = ['wrangler', 'd1', 'execute', 'family-planner'];
if (remote) target.push('--remote');
else target.push('--local');
if (persistTo && !remote) target.push('--persist-to', persistTo);

const runWrangler = (extra) =>
  execFileSync('npx', [...target, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });

// A database that has never been opened has no tables at all. Start it from the
// baseline migration so the inserts below have somewhere to go; the Worker
// applies the remaining migrations (and their data-safe rebuild) on first boot.
let schema = [];
try {
  const probe = runWrangler(['--command', "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"]);
  if (!/"name":\s*"users"/.test(probe)) {
    schema = MIGRATIONS[0].statements;
    console.log('seed: creating the baseline schema');
  }
} catch {
  schema = MIGRATIONS[0].statements;
}

const sqlFile = resolve('.tmp/seed.sql');
mkdirSync(dirname(sqlFile), { recursive: true });
// wrangler splits the file on semicolons, so every statement needs its own.
const sql = [...schema, ...statements].join(';\n').replace(/;;/g, ';');
writeFileSync(sqlFile, `${sql}\n`, 'utf8');

try {
  const out = runWrangler(['--file', '.tmp/seed.sql']);
  const ok = /"success":\s*true/.test(out);
  console.log(ok ? 'seed: database written' : 'seed: wrangler did not report success');
  if (!ok) console.log(out.slice(0, 1200));
} finally {
  rmSync(sqlFile, { force: true });
}

console.log(`seed: ${remote ? 'remote' : 'local'} household ready`);
console.log(`  email:    ${email}`);
if (password === 'SeedPass123') console.log('  password: SeedPass123 (the documented demo password)');
else console.log('  password: the one passed on the command line');
console.log(`  records:  ${rows} across ${COLLECTION_NAMES.length} collections`);
console.log('  note: profiles are created on the first request; sign in after starting the app.');
