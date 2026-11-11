#!/usr/bin/env node
// Import a contacts file into one book through the app's own endpoint.
//
// Nothing is written until the accounting is printed and the caller passes
// --import. The mapping is shared with the browser (web/src/contactMap.js), so a
// file that imports here imports the same way in the app.
//
//   node scripts/import-contacts.mjs --file "C:\path\contacts.csv" --email you@example.com --book Family
//   ...add --import to actually write (after reading the dry run).
//
// The password is never taken from the command line: it is read from
// %USERPROFILE%\.ffp-keys\import-password.txt (or --password-file), so it does
// not land in shell history, logs or chat.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CONTACT_IMPORT_LIMITS,
  detectContactFormat,
  docsFromGoogleRows,
  importDecision,
} from '../web/src/contactMap.js';
import { docsFromRows } from '../web/src/exporters.js';
import { readImportFile } from '../web/src/sheets.js';

const BASE = (process.env.FFP_BASE_URL || 'https://family-finance-planner.tarungudipatimadhav.workers.dev').replace(/\/$/, '');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}

const file = arg('file');
const email = arg('email');
const book = arg('book');
const write = process.argv.includes('--import');
const passwordFile = arg('password-file', join(homedir(), '.ffp-keys', 'import-password.txt'));

function fail(message) {
  console.error(`stop: ${message}`);
  process.exit(1);
}

if (!file) fail('--file is required');
if (!email) fail('--email is required (the account that owns the target book)');
if (!book) fail('--book is required (the book name to import into)');

/* ------------------------------------------------------------------ parse */

const bytes = readFileSync(file);
const fileName = file.split(/[\\/]/).pop();
if (bytes.length > CONTACT_IMPORT_LIMITS.bytes) fail(`file is over the ${CONTACT_IMPORT_LIMITS.bytes / 1048576} MB limit`);

const { rows } = await readImportFile(new File([bytes], fileName, { type: 'text/csv' }));
const detected = detectContactFormat((rows && rows[0]) || []);
let mapped;
if (detected.format === 'google') {
  mapped = docsFromGoogleRows(rows);
} else if (detected.format === 'template') {
  mapped = docsFromRows('contacts', rows);
} else {
  fail(`unrecognised format: ${detected.reason}. Supported: the planner contact template, or a Google Contacts export.`);
}

const total = mapped.rows || 0;
const rejected = (mapped.errors || []).length;
const decision = importDecision({ total, rejected });

/* ----------------------------------------------------------------- report */

console.log(`file:      ${fileName} (${bytes.length} bytes)`);
console.log(`format:    ${detected.reason}`);
console.log(`data rows: ${total}`);
if (mapped.report) {
  const r = mapped.report;
  console.log(`would create:      ${mapped.docs.length}`);
  console.log(`skipped (no name): ${r.skippedNoName}`);
  console.log(`skipped (duplicate in file): ${r.skippedDuplicate}`);
  console.log(`phone kept as written (no country code): ${r.flaggedPhone.length}`);
  r.flaggedPhone.slice(0, 10).forEach((f) => console.log(`  line ${f.row}`));
  console.log(`not imported: ${r.unmapped.length ? r.unmapped.join(', ') : 'nothing'}`);
  if (r.truncated) console.log(`shortened cells: ${r.truncated}`);
}
if (mapped.warnings && mapped.warnings.length) {
  mapped.warnings.slice(0, 20).forEach((w) => console.log(`  warning line ${w.row}${w.field ? ` ${w.field}` : ''}: ${w.message}`));
  if (mapped.warnings.length > 20) console.log(`  and ${mapped.warnings.length - 20} more warnings`);
}
if (rejected) {
  mapped.errors.slice(0, 40).forEach((e) => console.log(`  rejected line ${e.row}: ${e.message}`));
}
console.log(`limits: ${CONTACT_IMPORT_LIMITS.bytes / 1048576} MB, ${CONTACT_IMPORT_LIMITS.rows} rows per file, ${CONTACT_IMPORT_LIMITS.batch} rows per batch`);

if (!mapped.docs.length) fail('nothing to import');
if (!decision.ok) fail(decision.reason);
if (!write) {
  console.log('\ndry run: nothing was written. Re-run with --import after checking the counts above.');
  process.exit(0);
}

/* ----------------------------------------------------------------- import */

const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
if (!password) fail(`the password file ${passwordFile} is empty`);

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ email, password }),
});
const cookieHeader = loginRes.headers.get('set-cookie') || '';
const cookie = (cookieHeader.match(/ffp_session=[^;]+/) || [])[0];
if (!loginRes.ok || !cookie) fail(`sign-in failed for the given account (status ${loginRes.status})`);

const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie, 'X-Space': 'family' };

const profilesRes = await fetch(`${BASE}/api/profiles`, { headers });
if (!profilesRes.ok) fail(`could not list books (status ${profilesRes.status})`);
const profiles = (await profilesRes.json()).profiles || [];
const target = profiles.find((p) => String(p.name).toLowerCase() === book.toLowerCase());
if (!target) fail(`no book named "${book}" on this account: ${profiles.map((p) => p.name).join(', ')}`);
headers['X-Profile'] = target.id;

async function contactsInBook() {
  const res = await fetch(`${BASE}/api/state?since=0`, { headers });
  if (!res.ok) return null;
  const payload = await res.json();
  const found = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    for (const [k, val] of Object.entries(v)) {
      if (k === 'contacts' && Array.isArray(val)) found.push(val.length);
      else walk(val, depth + 1);
    }
  };
  walk(payload, 0);
  return found.length ? Math.max(...found) : null;
}

const before = await contactsInBook();
let added = 0;
let skipped = 0;
for (let i = 0; i < mapped.docs.length; i += CONTACT_IMPORT_LIMITS.batch) {
  const chunk = mapped.docs.slice(i, i + CONTACT_IMPORT_LIMITS.batch);
  const res = await fetch(`${BASE}/api/records/bulk`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ collection: 'contacts', docs: chunk }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`batch starting at row ${i + 2} failed (status ${res.status}): ${data.error || 'no message'} — nothing from that batch was written`);
  added += Number(data.added || 0);
  skipped += Number(data.skipped || 0);
  console.log(`batch ${i + 1}-${i + chunk.length}: added ${data.added || 0}, skipped ${data.skipped || 0}`);
}

const after = await contactsInBook();
console.log(`\nimported: added ${added}, skipped ${skipped}`);
if (before != null && after != null) console.log(`contacts in "${target.name}": ${before} → ${after} (expected ${before + added})`);
