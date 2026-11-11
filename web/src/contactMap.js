// The contact mapping layer: whatever a directory export hands us → planner
// contact documents.
//
// Pure on purpose (rows in, docs out; no DOM, no fetch), so the browser importer
// in app.js and scripts/import-contacts.mjs run the same mapping instead of two
// lookalike implementations that drift apart.

/** The columns our own template writes (see csvTemplate('contacts')). */
export const CONTACT_TEMPLATE_HEADERS = [
  'Name',
  'Relationship',
  'Mobile',
  'Alternative',
  'Email',
  'Birthday',
  'Organisation',
  'Linked module',
  'Remarks',
];

/**
 * Columns a Google Contacts export carries that the planner has no field for.
 * They are reported, never imported: dropping them silently is what makes people
 * re-import the same file "to see what went missing".
 */
export const GOOGLE_UNMAPPED = [
  'Name Prefix',
  'Name Suffix',
  'Nickname',
  'Phonetic First Name',
  'Phonetic Middle Name',
  'Phonetic Last Name',
  'Organization Department',
  'Photo',
  'Labels',
  'Website 1 - Label',
  'Website 1 - Value',
];

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const lower = (v) => clean(v).toLowerCase();

/** Google puts several values in one cell, separated by ::: in older exports. */
function splitValues(cell) {
  return String(cell == null ? '' : cell)
    .split(':::')
    .map(clean)
    .filter(Boolean);
}

/**
 * Which of the two supported contact formats this header row is.
 * Returns { format: 'google' | 'template' | 'unknown', reason }.
 */
export function detectContactFormat(firstRow) {
  const head = (firstRow || []).map(lower);
  const has = (...names) => names.some((n) => head.includes(lower(n)));
  if (has('First Name', 'Middle Name', 'Last Name', 'File As') && has('Phone 1 - Value', 'E-mail 1 - Value')) {
    return { format: 'google', reason: 'Google Contacts export' };
  }
  if (has('First Name', 'File As', 'Phone 1 - Value', 'E-mail 1 - Value')) {
    return { format: 'google', reason: 'Google Contacts export' };
  }
  if (has('Name') && has('Mobile', 'Relationship', 'Alternative')) {
    return { format: 'template', reason: 'planner contact template' };
  }
  return { format: 'unknown', reason: 'not a recognised contact file' };
}

/**
 * E.164 where the file carries a country code, the value as written otherwise.
 * A number without a country code is never guessed at: +91 is this household's
 * convention, not everyone's, so the caller is told to look at it instead.
 */
export function toE164(raw) {
  const text = clean(raw);
  if (!text) return { value: '', flagged: false };
  const compact = text.replace(/[^\d+]/g, '');
  if (compact.startsWith('+')) {
    const digits = compact.slice(1).replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) return { value: `+${digits}`, flagged: false };
    return { value: text, flagged: true };
  }
  const digits = compact.replace(/\D/g, '');
  if (/^00\d{8,15}$/.test(digits)) return { value: `+${digits.slice(2)}`, flagged: false };
  return { value: text, flagged: true };
}

/** The same key the server dedupes contacts on: the last 10 digits. */
export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function phoneColumns(head) {
  const cols = [];
  head.forEach((h, i) => {
    const m = clean(h).match(/^phone\s+(\d+)\s*-\s*value$/i);
    if (m) {
      const labelAt = head.findIndex((x) => lower(x) === lower(`Phone ${m[1]} - Label`));
      cols.push({ at: i, n: Number(m[1]), labelAt });
    }
  });
  return cols.sort((a, b) => a.n - b.n);
}

/**
 * A Google export → contact documents.
 *
 * Mapping: name = First + Middle + Last (File As when those are empty), Mobile
 * prefers a cell/mobile-labelled number, Alternative is the next distinct one,
 * Email from E-mail 1/2, Birthday, Organisation (Title when Name is empty),
 * Remarks from Notes. Relationship and Linked module have no Google source.
 *
 * Returns the same { docs, errors, warnings, rows } shape as docsFromRows(), plus
 * a `report` the caller can show: skipped empties, in-file duplicates, flagged
 * (not-E.164) phone numbers and the columns that were not imported.
 */
export function docsFromGoogleRows(rows) {
  const all = (rows || []).filter(
    (r) => Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== ''),
  );
  const empty = {
    docs: [],
    errors: [{ row: 0, message: 'That file is empty' }],
    warnings: [],
    rows: 0,
    format: 'google',
    report: { skippedNoName: 0, skippedDuplicate: 0, flaggedPhone: [], unmapped: [], truncated: 0 },
  };
  if (!all.length) return empty;

  const head = all[0].map(clean);
  const at = (name) => head.findIndex((h) => lower(h) === lower(name));
  const iFirst = at('First Name');
  const iMiddle = at('Middle Name');
  const iLast = at('Last Name');
  const iFileAs = at('File As');
  const iBirthday = at('Birthday');
  const iNotes = at('Notes');
  const iOrg = at('Organization Name');
  const iTitle = at('Organization Title');
  const emails = [at('E-mail 1 - Value'), at('E-mail 2 - Value')].filter((i) => i >= 0);
  const phones = phoneColumns(head);
  if (iFirst < 0 && iFileAs < 0 && iOrg < 0) {
    return { ...empty, errors: [{ row: 1, message: 'This does not look like a Google Contacts export (no First Name, File As or Organization Name column)' }] };
  }

  const used = new Set(
    [iFirst, iMiddle, iLast, iFileAs, iBirthday, iNotes, iOrg, iTitle, ...emails].filter((i) => i >= 0),
  );
  phones.forEach((c) => {
    used.add(c.at);
    if (c.labelAt >= 0) used.add(c.labelAt);
  });
  const unmapped = [];
  head.forEach((h, i) => {
    if (!h || used.has(i)) return;
    unmapped.push(h);
  });

  const docs = [];
  const warnings = [];
  const flaggedPhone = [];
  const seen = new Set();
  let skippedNoName = 0;
  let skippedDuplicate = 0;
  let truncated = 0;
  const cell = (row, i) => (i >= 0 ? clean(row[i]) : '');

  for (let r = 1; r < all.length; r += 1) {
    const row = all[r];
    const line = r + 1; // the spreadsheet's own line number
    const joined = [cell(row, iFirst), cell(row, iMiddle), cell(row, iLast)].filter(Boolean).join(' ');
    const name = clean(joined) || cell(row, iFileAs);
    if (!name) {
      skippedNoName += 1;
      continue;
    }

    // Phones: labelled mobile/cell first, then the rest in column order.
    const found = [];
    phones.forEach((c) => {
      const label = c.labelAt >= 0 ? lower(row[c.labelAt]) : '';
      splitValues(row[c.at]).forEach((value) => {
        if (!found.some((f) => phoneKey(f.value) === phoneKey(value) && phoneKey(value))) found.push({ value, label });
      });
    });
    const preferred = found.filter((f) => /mobile|cell/i.test(f.label));
    const ordered = [...preferred, ...found.filter((f) => !preferred.includes(f))];
    const mobileOut = ordered.length ? toE164(ordered[0].value) : { value: '', flagged: false };
    if (mobileOut.flagged) flaggedPhone.push({ row: line, value: mobileOut.value });
    const altRaw = ordered.length > 1 ? ordered[1].value : '';
    const altOut = altRaw ? toE164(altRaw) : { value: '', flagged: false };
    if (altOut.flagged) flaggedPhone.push({ row: line, value: altOut.value });

    let email = '';
    for (const i of emails) {
      const value = cell(row, i);
      if (value) {
        email = value;
        break;
      }
    }

    // A duplicate inside one file is skipped exactly like one already in the book.
    const keys = [phoneKey(mobileOut.value), phoneKey(altOut.value), email ? `e:${email.toLowerCase()}` : ''].filter(Boolean);
    if (keys.some((k) => seen.has(k))) {
      skippedDuplicate += 1;
      continue;
    }
    keys.forEach((k) => seen.add(k));

    const bday = cell(row, iBirthday).match(/^(\d{4}-\d{2}-\d{2})/);
    const org = cell(row, iOrg) || cell(row, iTitle);
    const remarks = cell(row, iNotes);
    const doc = {
      name,
      rel: '',
      mobile: mobileOut.value,
      alt: altOut.value,
      email,
      bday: bday ? bday[1] : '',
      org,
      module: '',
      remarks,
    };
    // Same limits the server enforces on every write; shortening is reported, not hidden.
    const limits = { name: 120, rel: 60, email: 120, org: 160, remarks: 400 };
    Object.entries(limits).forEach(([k, max]) => {
      if (doc[k] && doc[k].length > max) {
        doc[k] = doc[k].slice(0, max);
        truncated += 1;
        warnings.push({ row: line, field: k, message: `shortened to ${max} characters` });
      }
    });
    docs.push(doc);
  }

  return {
    docs,
    errors: [],
    warnings,
    rows: all.length - 1,
    format: 'google',
    report: { skippedNoName, skippedDuplicate, flaggedPhone, unmapped, truncated },
  };
}

/**
 * The stop rule for a real import: more than a tenth of the rows rejected means
 * the file is the wrong shape, and importing the rest hides that.
 */
export function importDecision({ total = 0, rejected = 0 } = {}) {
  if (!total) return { ok: false, reason: 'no data rows' };
  const share = rejected / total;
  if (share > 0.1) {
    return { ok: false, reason: `${rejected} of ${total} rows rejected (${Math.round(share * 100)}%, over the 10% limit)` };
  }
  return { ok: true, reason: '' };
}

/** Limits, stated in one place so the UI, the CLI and the docs agree. */
export const CONTACT_IMPORT_LIMITS = {
  bytes: 2 * 1024 * 1024,
  rows: 500,
  batch: 500,
};
