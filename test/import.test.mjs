// CSV and Excel import: reading the file, mapping columns, naming bad rows,
// and making sure the same file twice cannot double the ledger.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import { bulkCreate } from '../src/store.js';
import { docsFromCsv, docsFromRows } from '../web/src/exporters.js';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, readImportFile, readXlsx } from '../web/src/sheets.js';
import { makeDatabase } from './helpers/d1.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

async function fileOf(name, type = '') {
  const bytes = await readFile(fixture(name));
  return new File([bytes], name, { type });
}

async function envWithSchema() {
  const { db, env } = makeDatabase();
  await applyMigrations(env);
  return { db, env };
}

test('a BOM, quoted commas and dd/mm/yyyy survive the CSV reader', async () => {
  const { rows } = await readImportFile(await fileOf('import-good.csv', 'text/csv'));
  const parsed = docsFromRows('expenses', rows);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.docs.length, 4);
  const [first] = parsed.docs;
  assert.equal(first.date, '2026-03-04');
  assert.equal(first.item, 'Nilgiris "big" shop, weekly');
  assert.equal(first.amount, 2450.5);
  assert.equal(first.status, 'Paid');
  // An amount written the Indian way, and a date written dd/mm/yyyy.
  assert.equal(parsed.docs[2].date, '2026-03-12');
  assert.equal(parsed.docs[3].amount, 123456);
});

test('the same rows read from a real .xlsx give the same documents', async () => {
  const bytes = await readFile(fixture('import-good.xlsx'));
  const rows = await readXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const fromSheet = docsFromRows('expenses', rows);
  const fromCsvText = docsFromCsv('expenses', await readFile(fixture('import-good.csv'), 'utf8'));
  assert.deepEqual(fromSheet.errors, []);
  assert.deepEqual(fromSheet.docs, fromCsvText.docs);
  // Excel stores dates as day counts; they must arrive as plain ISO dates.
  assert.equal(fromSheet.docs[0].date, '2026-03-04');
  assert.equal(fromSheet.docs[1].date, '2026-03-05');
});

test('bad cells are reported by line and column, and nothing is returned', () => {
  const parsed = docsFromCsv(
    'expenses',
    [
      'Date,Expense / merchant,Amount,Status',
      '04/03/2026,Fine row,120,Paid',
      '31/02/2026,Impossible date,120,Paid',
      '05/03/2026,Bad amount,twelve,Paid',
      '06/03/2026,Bad status,120,Pendi',
    ].join('\n'),
  );
  assert.equal(parsed.docs.length, 0, 'a file with any bad row imports nothing');
  const messages = parsed.errors.map((e) => `${e.row} ${e.field}: ${e.message}`);
  assert.equal(messages.length, 3, messages.join(' | '));
  assert.match(messages[0], /^3 Date: "31\/02\/2026" is not a real date/);
  assert.match(messages[1], /^4 Amount: "twelve" is not an amount/);
  assert.match(messages[2], /^5 Status: "Pendi" is not one of Paid \/ Unpaid/);
});

test('an empty file and a header-only file each explain themselves', async () => {
  await assert.rejects(
    readImportFile(new File([''], 'empty.csv', { type: 'text/csv' })),
    /That file is empty/,
  );
  const headerOnly = docsFromCsv('expenses', 'Date,Amount\n');
  assert.equal(headerOnly.docs.length, 0);
  assert.match(headerOnly.errors[0].message, /No data rows/);
  const noHeaders = docsFromCsv('expenses', 'a,b,c\n1,2,3');
  assert.equal(noHeaders.docs.length, 0);
  assert.match(noHeaders.errors[0].message, /No column headers matched/);
});

test('the row limit and the size limit are refused before anything is written', async () => {
  const head = 'Date,Expense / merchant,Amount,Status\n';
  const row = '04/03/2026,Row,120,Paid\n';
  const tooMany = head + row.repeat(5001);
  const parsed = docsFromCsv('expenses', tooMany);
  assert.equal(parsed.docs.length, 0);
  assert.match(parsed.errors[0].message, /at most 5000/);
  assert.equal(docsFromCsv('expenses', head + row.repeat(5000)).docs.length, 5000);

  const big = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], 'big.csv', { type: 'text/csv' });
  await assert.rejects(readImportFile(big), /the limit is 2 MB/);
});

test('importing the same file twice writes the rows once', async () => {
  const { env } = await envWithSchema();
  const { rows } = await readImportFile(await fileOf('import-good.csv', 'text/csv'));
  const { docs } = docsFromRows('expenses', rows);

  const first = await bulkCreate(env, 'family', 'expenses', docs, 'tester');
  assert.deepEqual(first, { added: 4, skipped: 0 });
  const second = await bulkCreate(env, 'family', 'expenses', docs, 'tester');
  assert.deepEqual(second, { added: 0, skipped: 4 });

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM records WHERE space = 'family' AND collection = 'expenses'`,
  ).first();
  assert.equal(count.n, 4);

  // A duplicate inside one file is caught the same way.
  const again = await bulkCreate(env, 'family', 'expenses', [docs[0], docs[0]], 'tester');
  assert.deepEqual(again, { added: 0, skipped: 2 });
});

test('contacts still dedupe on the mobile number, not just on content', async () => {
  const { env } = await envWithSchema();
  const dedupeKey = (doc) => {
    const digits = String(doc.mobile || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  };
  const one = { name: 'Amma', mobile: '+91 98400 12345', rel: 'Mother' };
  const two = { name: 'Amma (old row)', mobile: '9840012345', rel: 'Mother' };
  const first = await bulkCreate(env, 'family', 'contacts', [one, two], 'tester', { dedupeKey });
  assert.deepEqual(first, { added: 1, skipped: 1 });
});

test('an import larger than the batch limit is refused by the server too', async () => {
  const { env } = await envWithSchema();
  // 5001 rows should be rejected (over the 5000 limit)
  const docs = Array.from({ length: 5001 }, (_, i) => ({ date: '2026-03-04', item: `Row ${i}`, amount: i }));
  await assert.rejects(bulkCreate(env, 'family', 'expenses', docs, 'tester'), /Import at most 5000 rows/);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE collection = 'expenses'`).first();
  assert.equal(count.n, 0, 'a refused import must not have written anything');
});

test('a workbook saved as .csv is read as a workbook, not as text', async () => {
  const bytes = await readFile(fixture('import-good.xlsx'));
  // Some downloads (and every "Save as" dialog that guesses) rename the file.
  const file = new File([bytes], 'contacts.csv', { type: 'text/csv' });
  const { rows, isXlsx } = await readImportFile(file);
  assert.equal(isXlsx, true, 'the ZIP signature should win over the extension');
  const parsed = docsFromRows('expenses', rows);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.docs.length, 4);
  assert.equal(parsed.docs[0].date, '2026-03-04');
});
