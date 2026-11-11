// Contact mapping: the planner template and a Google Contacts export both land
// in the same nine fields, without a second importer and without duplicates.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMigrations } from '../src/migrations/runner.js';
import { bulkCreate } from '../src/store.js';
import {
  CONTACT_TEMPLATE_HEADERS,
  detectContactFormat,
  docsFromGoogleRows,
  importDecision,
  phoneKey,
  toE164,
} from '../web/src/contactMap.js';
import { docsFromCsv } from '../web/src/exporters.js';
import { parseDelimited } from '../web/src/sheets.js';
import { makeDatabase } from './helpers/d1.mjs';

const GOOGLE_HEAD = [
  'First Name',
  'Middle Name',
  'Last Name',
  'Phonetic First Name',
  'Name Prefix',
  'Nickname',
  'File As',
  'Organization Name',
  'Organization Title',
  'Organization Department',
  'Birthday',
  'Notes',
  'Photo',
  'Labels',
  'E-mail 1 - Label',
  'E-mail 1 - Value',
  'E-mail 2 - Value',
  'Phone 1 - Label',
  'Phone 1 - Value',
  'Phone 2 - Label',
  'Phone 2 - Value',
  'Phone 3 - Label',
  'Phone 3 - Value',
  'Address 1 - Formatted',
  'Website 1 - Value',
];

function googleRows(extra = []) {
  return [
    GOOGLE_HEAD,
    [
      'Anitha', 'R', 'Menon', 'Anitha', '', 'Ani', 'Anitha R Menon',
      'Menon Textiles', 'Owner', 'Sales', '1984-06-12', 'Met at the school expo',
      '', '* myContacts', 'Home', 'anitha@example.com', '', 'Work', '044 2345 6789',
      'Mobile', '+91 98400 12345', '', '', 'Kochi', '',
    ],
    [
      '', '', '', '', '', '', 'Kumar Stores', '', 'Proprietor', '', '', '',
      '', '', '', '', '', '', '', '', '', '', '', '', '',
    ],
    ...extra,
  ];
}

test('a Google export maps onto the nine contact fields', () => {
  const head = GOOGLE_HEAD;
  const first = googleRows()[1];
  const mapped = docsFromGoogleRows([head, first]);
  assert.deepEqual(mapped.errors, []);
  assert.equal(mapped.docs.length, 1);
  const [doc] = mapped.docs;
  assert.equal(doc.name, 'Anitha R Menon');
  assert.equal(doc.rel, '', 'relationship has no Google source');
  assert.equal(doc.module, '', 'linked module has no Google source');
  // A Mobile-labelled number wins over a landline, and it is E.164.
  assert.equal(doc.mobile, '+919840012345');
  assert.equal(doc.alt, '044 2345 6789');
  assert.equal(doc.email, 'anitha@example.com');
  assert.equal(doc.bday, '1984-06-12');
  assert.equal(doc.org, 'Menon Textiles');
  assert.equal(doc.remarks, 'Met at the school expo', 'Notes is the only remarks source');
  // A number without a country code is kept as written and flagged, never guessed.
  assert.deepEqual(mapped.report.flaggedPhone, [{ row: 2, value: '044 2345 6789' }]);
});

test('columns with no planner field are reported, never imported', () => {
  const mapped = docsFromGoogleRows(googleRows());
  const unmapped = mapped.report.unmapped;
  for (const column of [
    'Phonetic First Name',
    'Name Prefix',
    'Nickname',
    'Organization Department',
    'Photo',
    'Labels',
    'E-mail 1 - Label',
    'Address 1 - Formatted',
    'Website 1 - Value',
  ]) {
    assert.ok(unmapped.includes(column), `${column} should be reported as unmapped`);
  }
  assert.ok(!mapped.docs.some((d) => Object.keys(d).length !== 9), 'a document carries exactly the nine fields');
});

test('File As names a row with no name parts, a nameless row is skipped, a repeat is dropped', () => {
  // A row with only a note has data but no name: skipped, and counted.
  const nameless = Array(25).fill('');
  nameless[11] = 'note but nobody';
  const mapped = docsFromGoogleRows(
    googleRows([
      nameless,
      ['Duplicate', 'Person', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Mobile', '+91 98400 12345', '', '', '', ''],
    ]),
  );
  assert.equal(mapped.docs.length, 2, 'the File As row and the first row only');
  assert.equal(mapped.docs[1].name, 'Kumar Stores');
  assert.equal(mapped.report.skippedNoName, 1);
  assert.equal(mapped.report.skippedDuplicate, 1, 'the same mobile number twice in one file');
  // A completely blank line is not a row at all, so it is not counted as skipped.
  const blank = docsFromGoogleRows(googleRows([Array(25).fill('')]));
  assert.equal(blank.report.skippedNoName, 0);
  assert.equal(blank.docs.length, 2);
});

test('the format is read from the header row, not the file name', () => {
  assert.equal(detectContactFormat(GOOGLE_HEAD).format, 'google');
  assert.equal(detectContactFormat(CONTACT_TEMPLATE_HEADERS).format, 'template');
  assert.equal(detectContactFormat(['Date', 'Amount', 'Status']).format, 'unknown');
  // The same file arriving through the CSV reader keeps its shape.
  const rows = parseDelimited([CONTACT_TEMPLATE_HEADERS.join(','), 'Amma,Mother,+91 98400 11111,,amma@example.com,1958-02-03,Home,,'].join('\n'));
  const parsed = docsFromCsv('contacts', [CONTACT_TEMPLATE_HEADERS.join(','), 'Amma,Mother,+91 98400 11111,,amma@example.com,1958-02-03,Home,,'].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.docs[0].name, 'Amma');
  assert.equal(parsed.docs[0].mobile, '+91 98400 11111');
});

test('re-importing a Google export writes nothing the second time', async () => {
  const { env } = makeDatabase();
  await applyMigrations(env);
  const { docs } = docsFromGoogleRows(googleRows());
  const dedupeKey = (doc) => phoneKey(doc.mobile);

  const first = await bulkCreate(env, 'family', 'contacts', docs, 'tester', { dedupeKey });
  assert.deepEqual(first, { added: 2, skipped: 0 });
  const second = await bulkCreate(env, 'family', 'contacts', docs, 'tester', { dedupeKey });
  assert.deepEqual(second, { added: 0, skipped: 2 });

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM records WHERE space = 'family' AND collection = 'contacts'`,
  ).first();
  assert.equal(count.n, 2);
});

test('phone numbers become E.164 only when the file carries a country code', () => {
  assert.deepEqual(toE164('+91 98400 12345'), { value: '+919840012345', flagged: false });
  assert.deepEqual(toE164('0091 98400 12345'), { value: '+919840012345', flagged: false });
  assert.deepEqual(toE164('9840012345'), { value: '9840012345', flagged: true });
  assert.deepEqual(toE164('  '), { value: '', flagged: false });
});

test('a file that rejects more than a tenth of its rows is stopped', () => {
  assert.equal(importDecision({ total: 100, rejected: 10 }).ok, true, 'exactly 10% still runs');
  assert.equal(importDecision({ total: 100, rejected: 11 }).ok, false);
  assert.match(importDecision({ total: 100, rejected: 11 }).reason, /over the 10% limit/);
  assert.equal(importDecision({ total: 0, rejected: 0 }).ok, false);
});
