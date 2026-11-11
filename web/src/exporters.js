// CSV / ICS / backup helpers carried over from the reference planner.

import { COLLECTIONS } from './entities.js';
import { docsFromGoogleRows } from './contactMap.js';
import { S } from './state.js';
import { alertsList, bdayNext, openTasks, taskDue } from './analytics.js';
import { daysTo, dfmt, iso, money, pd } from './format.js';

export function download(name, text, mime = 'text/plain') {
  try {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(a.href);
    }, 500);
  } catch {
    alert('Download is not available in this context');
  }
}

export function csvOf(collection) {
  const def = COLLECTIONS[collection];
  const q = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = def.fields.map((f) => q(f.l)).join(',');
  const body = (S.db[collection] || []).map((row) => def.fields.map((f) => q(row[f.k])).join(','));
  return `\ufeff${[head, ...body].join('\r\n')}`;
}

/**
 * Every record in the open book as one sheet: a `collection` and `id` column make
 * the rows identifiable, and the union of the fields is the header. Used by
 * "Download CSV" in Settings so the file is one download, not twenty.
 */
export function csvAll() {
  const q = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const columns = [];
  for (const name of Object.keys(COLLECTIONS)) {
    for (const f of COLLECTIONS[name].fields) if (!columns.includes(f.k)) columns.push(f.k);
  }
  const head = ['collection', 'id', ...columns].map(q).join(',');
  const rows = [];
  for (const name of Object.keys(COLLECTIONS)) {
    for (const row of S.db[name] || []) {
      rows.push([name, row.id, ...columns.map((k) => row[k])].map(q).join(','));
    }
  }
  return `\ufeff${[head, ...rows].join('\r\n')}`;
}

/* ------------------------------------------------------- Google Calendar */

function at(isoDate, hhmm, addMin = 0) {
  const d = pd(isoDate);
  const [h, m] = String(hhmm || '06:00').split(':');
  d.setHours(Number(h) || 6, (Number(m) || 0) + addMin, 0, 0);
  return d;
}

function stamp(d) {
  return `${d.getFullYear()}${('0' + (d.getMonth() + 1)).slice(-2)}${('0' + d.getDate()).slice(-2)}T${('0' + d.getHours()).slice(-2)}${('0' + d.getMinutes()).slice(-2)}00`;
}

function eventFor(collection, row) {
  if (collection === 'diary') {
    return {
      title: `[Planner] TASK: ${row.title} (${row.status})`,
      date: taskDue(row),
      desc: `Follow-up: ${row.follow || '-'}\nContact: ${row.contact || ''} ${row.phone || ''}`,
      alarms: [1440, 0],
    };
  }
  if (collection === 'payments') {
    return {
      title: `[Planner] BILL DUE: ${row.payee} - ${money(row.amount)}`,
      date: row.due,
      desc: `Contact: ${row.contact || ''} ${row.phone || ''}`,
      alarms: [4320, 1440, 0],
    };
  }
  return {
    title: `[Planner] RENEWAL: ${row.name}`,
    date: row.renewal,
    desc: `Premium ${money(row.premium)}\nAdvisor: ${row.advisor || ''} ${row.phone || ''}`,
    alarms: [43200, 21600, 10080, 1440],
  };
}

export function googleCalendarLink(collection, row) {
  const e = eventFor(collection, row);
  if (!pd(e.date)) return '#';
  const t = S.settings.alertTime || '06:00';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${stamp(at(e.date, t))}/${stamp(at(e.date, t, 30))}`,
    details: e.desc,
    ctz: 'Asia/Kolkata',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function fold(line) {
  let out = '';
  let rest = line;
  while (rest.length > 72) {
    out += `${rest.slice(0, 72)}\r\n `;
    rest = rest.slice(72);
  }
  return out + rest;
}

function icsEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export function buildICS() {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Finance Planner//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Family Finance Planner',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Kolkata',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0530',
    'TZOFFSETTO:+0530',
    'TZNAME:IST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${('0' + (now.getUTCMonth() + 1)).slice(-2)}${('0' + now.getUTCDate()).slice(-2)}T${('0' + now.getUTCHours()).slice(-2)}${('0' + now.getUTCMinutes()).slice(-2)}00Z`;
  const time = S.settings.alertTime || '06:00';
  let count = 0;

  const add = (uid, title, desc, start, end, alarms, allDay = false, extra = '') => {
    count += 1;
    lines.push('BEGIN:VEVENT', `UID:${uid}@family-finance-planner`, `DTSTAMP:${dtstamp}`);
    if (allDay) lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
    else lines.push(`DTSTART;TZID=Asia/Kolkata:${start}`, `DTEND;TZID=Asia/Kolkata:${end}`);
    if (extra) lines.push(extra);
    lines.push(fold(`SUMMARY:${icsEscape(title)}`), fold(`DESCRIPTION:${icsEscape(desc)}`));
    alarms.forEach((minutes) => {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:-PT${minutes}M`, 'END:VALARM');
    });
    lines.push('END:VEVENT');
  };

  const key = (s) => String(s).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

  (S.db.diary || []).forEach((r) => {
    if (r.status === 'Completed') return;
    const e = eventFor('diary', r);
    add(`task-${key(r.date + r.title)}`, e.title, e.desc, stamp(at(e.date, time)), stamp(at(e.date, time, 30)), e.alarms);
  });
  (S.db.payments || []).forEach((r) => {
    if (r.status === 'Paid' || !pd(r.due)) return;
    const e = eventFor('payments', r);
    add(`bill-${key(r.due + r.payee)}`, e.title, e.desc, stamp(at(e.date, time)), stamp(at(e.date, time, 30)), e.alarms);
  });
  (S.db.insurance || []).forEach((r) => {
    if (!pd(r.renewal) || daysTo(r.renewal) < 0) return;
    const e = eventFor('insurance', r);
    add(`ins-${key(r.renewal + r.name)}`, e.title, e.desc, stamp(at(e.date, time)), stamp(at(e.date, time, 30)), e.alarms);
  });
  (S.db.contacts || []).forEach((c) => {
    const b = bdayNext(c);
    if (!b) return;
    const d = b.date;
    const start = `${d.getFullYear()}${('0' + (d.getMonth() + 1)).slice(-2)}${('0' + d.getDate()).slice(-2)}`;
    const endDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const end = `${endDate.getFullYear()}${('0' + (endDate.getMonth() + 1)).slice(-2)}${('0' + endDate.getDate()).slice(-2)}`;
    add(`bday-${key(c.name + c.bday)}`, `[Planner] BIRTHDAY: ${c.name}`, `Mobile: ${c.mobile || ''}`, start, end, [0], true, 'RRULE:FREQ=YEARLY');
  });
  lines.push('END:VCALENDAR');
  return { text: lines.join('\r\n'), count };
}

/* ----------------------------------------------------- Google CSV import */

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function normalizePhone(value) {
  const s = String(value || '').replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return `+91 ${d}`;
  if (d.length === 12 && d.slice(0, 2) === '91') return `+91 ${d.slice(2)}`;
  if (d.length === 11 && d[0] === '0') return `+91 ${d.slice(1)}`;
  return s[0] === '+' ? `+${d}` : d;
}

/**
 * Convert a Google Contacts CSV export into planner contact documents.
 * The mapping itself lives in contactMap.js so the browser and the CLI dry run
 * share one implementation; this keeps the name the app already imports.
 */
export function googleContactsToDocs(text) {
  return docsFromGoogleRows(parseCSV(text));
}

export function calendarFileName() {
  return `Family_Finance_Planner_Alerts_${iso(new Date())}.ics`;
}

/* ------------------------------------------------ CSV template + import */

/** Header-only CSV so a spreadsheet can be filled in without junk sample rows. */
export function csvTemplate(collection) {
  const def = COLLECTIONS[collection];
  const heads = def.fields
    .filter((f) => !(def.autoId && f.k === 'id') && f.t !== 'file')
    .map((f) => f.l);
  return `\ufeff${heads.join(',')}\r\n`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function realDate(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function twoDigitYear(y) {
  const n = Number(y);
  if (String(y).length >= 4) return n;
  return n <= 68 ? 2000 + n : 1900 + n;
}

/**
 * Read whatever a spreadsheet holds as a date. Day-first (dd/mm/yyyy) is the
 * household convention; a value that can only be month-first is read that way.
 * Returns { value } or { error } so the caller can name the bad row.
 */
export function parseDateValue(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return { value: '' };
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) {
    const ok = realDate(iso[1], iso[2], iso[3]);
    return ok ? { value: ok } : { error: `"${s}" is not a real date` };
  }
  const dmy = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (dmy) {
    let first = Number(dmy[1]);
    let second = Number(dmy[2]);
    if (first > 12 && second > 12) return { error: `"${s}" is not a real date` };
    if (second > 12) [first, second] = [second, first];
    const ok = realDate(twoDigitYear(dmy[3]), second, first);
    return ok ? { value: ok } : { error: `"${s}" is not a real date` };
  }
  const named = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-,.]+(\d{2,4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    if (month) {
      const ok = realDate(twoDigitYear(named[3]), month, named[1]);
      return ok ? { value: ok } : { error: `"${s}" is not a real date` };
    }
  }
  return { error: `"${s}" is not a date (use 31/12/2026 or 2026-12-31)` };
}

/**
 * Read a money cell: ₹ and separators are ignored, "12,345/-" and "(500)" work,
 * an empty cell is zero. Anything else is an error rather than a silent zero.
 */
export function parseMoneyValue(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return { value: 0 };
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/^\(|\)$/g, '').replace(/[₹$\u20b9\s,]/g, '').replace(/\/-$/, '').replace(/^-$/, '-');
  if (cleaned === '' || cleaned === '-' || /^(na|n\/a)$/i.test(cleaned)) return { value: 0 };
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) {
    return { error: `"${s}" is not an amount (use 1250 or 1,250.50)` };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { error: `"${s}" is not an amount` };
  return { value: negative ? -Math.abs(n) : n };
}

/** Rows accepted from one file. The Worker writes them in a single transaction. */
export const MAX_IMPORT_ROWS = 5000;

function matchColumns(def, head) {
  const columns = [];
  def.fields.forEach((f) => {
    if (def.autoId && f.k === 'id') return;
    const byLabel = head.indexOf(f.l.trim().toLowerCase());
    const byKey = head.indexOf(f.k.trim().toLowerCase());
    const at = byLabel >= 0 ? byLabel : byKey;
    if (at >= 0) columns.push({ at, field: f });
  });
  return columns;
}

/**
 * Map rows (already split into cells) onto one module's fields.
 *
 * Every problem is reported against the row number the user sees in their
 * spreadsheet, and one bad row rejects the file instead of importing half of
 * it — a silent "0 rows imported" is the bug this replaces.
 */
export function docsFromRows(collection, rows) {
  const def = COLLECTIONS[collection];
  if (!def) return { docs: [], errors: [{ row: 0, message: 'Unknown module' }] };
  const all = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== ''));
  if (!all.length) return { docs: [], errors: [{ row: 0, message: 'That file is empty' }] };

  const head = all[0].map((h) => String(h == null ? '' : h).trim().toLowerCase());
  const columns = matchColumns(def, head);
  if (!columns.length) {
    return {
      docs: [],
      errors: [
        {
          row: 1,
          message: `No column headers matched. The first row should name the fields, for example: ${def.fields
            .filter((f) => !(def.autoId && f.k === 'id'))
            .slice(0, 4)
            .map((f) => f.l)
            .join(', ')}`,
        },
      ],
    };
  }

  const dataRows = all.slice(1);
  if (!dataRows.length) return { docs: [], errors: [{ row: 2, message: 'No data rows below the header' }] };
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return {
      docs: [],
      errors: [
        {
          row: MAX_IMPORT_ROWS + 2,
          message: `That file has ${dataRows.length} rows; import at most ${MAX_IMPORT_ROWS} at a time (split the file)`,
        },
      ],
    };
  }

  const docs = [];
  const errors = [];
  const warnings = [];
  dataRows.forEach((row, i) => {
    const line = i + 2; // the spreadsheet's own line number: header is line 1
    const doc = {};
    columns.forEach(({ at, field }) => {
      const raw = String(row[at] == null ? '' : row[at]).trim();
      if (field.t === 'money' || field.t === 'pct') {
        const parsed = parseMoneyValue(raw);
        if (parsed.error) errors.push({ row: line, field: field.l, message: parsed.error });
        doc[field.k] = parsed.error ? 0 : parsed.value;
      } else if (field.t === 'date') {
        const parsed = parseDateValue(raw);
        if (parsed.error) errors.push({ row: line, field: field.l, message: parsed.error });
        doc[field.k] = parsed.error ? '' : parsed.value;
      } else if (field.t === 'select' && raw && Array.isArray(field.o) && !field.o.includes(raw)) {
        errors.push({ row: line, field: field.l, message: `"${raw}" is not one of ${field.o.join(' / ')}` });
        doc[field.k] = '';
      } else {
        if (field.max && raw.length > field.max) {
          warnings.push({ row: line, field: field.l, message: `shortened to ${field.max} characters` });
        }
        doc[field.k] = field.max ? raw.slice(0, field.max) : raw;
      }
    });
    docs.push(doc);
  });

  if (errors.length) return { docs: [], errors, warnings, rows: dataRows.length };
  return { docs, errors: [], warnings, rows: dataRows.length };
}

/** Turn CSV text written against csvTemplate() back into documents for the API. */
export function docsFromCsv(collection, text) {
  const src = String(text || '').replace(/^\ufeff/, '');
  if (!src.trim()) return { docs: [], errors: [{ row: 0, message: 'That file is empty' }] };
  return docsFromRows(collection, parseCSV(src));
}

/* ------------------------------------------------------------- plain text */

export function alertDigestText() {
  const alerts = alertsList();
  const head = `${S.settings.household || 'Family'} · Family Finance Planner`;
  if (!alerts.length) return `${head}\nNo pending alerts right now.`;
  const lines = alerts.slice(0, 8).map((a) => `- ${a.t}`);
  return `${head}\n${alerts.length} alert${alerts.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

export function recordMessage(collection, row) {
  const def = COLLECTIONS[collection];
  const who = row.name || row.payee || row.title || row.item || 'Record';
  if (collection === 'payments') {
    return `Reminder: ${who}\nAmount: ${money(row.amount)}\nDue: ${dfmt(row.due)}\nRef: ${row.ref || '-'}`;
  }
  if (collection === 'insurance') {
    return `Policy renewal: ${who}\nPremium: ${money(row.premium)}\nRenewal: ${dfmt(row.renewal)}\nPolicy no: ${row.policyno || '-'}`;
  }
  if (collection === 'diary') {
    return `Task: ${who}\nDue: ${dfmt(row.due || row.date)}\nFollow-up: ${row.follow || '-'}`;
  }
  if (collection === 'family') {
    return `${who} · ${row.relation || 'Family'}\nMobile: ${row.mobile || '-'}\nBirthday: ${row.bday ? dfmt(row.bday) : '-'}`;
  }
  return `${def.label}: ${who}`;
}

export function notificationMessage(note) {
  return `${note.title}\n${note.body || ''}`.trim();
}
