// CSV / ICS / backup helpers carried over from the reference planner.

import { COLLECTIONS } from './entities.js';
import { S } from './state.js';
import { alertsList, bdayNext, openTasks, taskDue } from './analytics.js';
import { daysTo, dfmt, digits, iso, money, pd } from './format.js';

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

/** Convert a Google Contacts CSV export into planner contact documents. */
export function googleContactsToDocs(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { docs: [], error: 'Empty file' };
  const head = rows[0];
  const idx = (name) => head.indexOf(name);
  const iFirst = idx('First Name');
  const iMiddle = idx('Middle Name');
  const iLast = idx('Last Name');
  const iOrg = idx('Organization Name');
  const iTitle = idx('Organization Title');
  const iBirthday = idx('Birthday');
  const iLabels = idx('Labels');
  const iEmail = idx('E-mail 1 - Value');
  const phoneCols = [];
  head.forEach((h, i) => {
    if (/^Phone \d - Value$/.test(h)) phoneCols.push(i);
  });
  if (iFirst < 0 && iOrg < 0) return { docs: [], error: 'This does not look like a Google Contacts CSV' };

  const docs = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const cell = (i) => (i >= 0 && row[i] ? String(row[i]).trim() : '');
    const name = [cell(iFirst), cell(iMiddle), cell(iLast)].filter(Boolean).join(' ') || cell(iOrg);
    const phones = [];
    phoneCols.forEach((i) => {
      String(row[i] || '').split(':::').forEach((p) => {
        const normalized = normalizePhone(p);
        if (normalized && !phones.includes(normalized)) phones.push(normalized);
      });
    });
    if (!name && !phones.length) continue;
    const dedupe = phones.length ? digits(phones[0]).slice(-10) : '';
    if (dedupe && seen.has(dedupe)) continue;
    if (dedupe) seen.add(dedupe);
    const bday = cell(iBirthday).match(/^(\d{4}-\d{2}-\d{2})/);
    docs.push({
      name: name || phones[0],
      rel: 'Google Contact',
      mobile: phones[0] || '-',
      alt: phones.slice(1, 3).join(', ') || '-',
      email: cell(iEmail).split(':::')[0] || '-',
      bday: bday ? bday[1] : '',
      org: [cell(iOrg) !== name ? cell(iOrg) : '', cell(iTitle)].filter(Boolean).join(' - ') || '-',
      module: 'Contacts Directory',
      remarks: cell(iLabels).replace(/\* /g, '').replace(/:::/g, ', ') || '-',
    });
  }
  return { docs };
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

function normaliseDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

/** Turn a CSV written against csvTemplate() back into documents for the API. */
export function docsFromCsv(collection, text) {
  const def = COLLECTIONS[collection];
  const rows = parseCSV(String(text || '').replace(/^\ufeff/, ''));
  if (!rows.length) return { docs: [], error: 'That file is empty' };
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const columns = {};
  def.fields.forEach((f) => {
    if (def.autoId && f.k === 'id') return;
    const byLabel = head.indexOf(f.l.toLowerCase());
    const byKey = head.indexOf(f.k.toLowerCase());
    const at = byLabel >= 0 ? byLabel : byKey;
    if (at >= 0) columns[f.k] = { at, field: f };
  });
  if (!Object.keys(columns).length) {
    return { docs: [], error: 'The first row must hold column headers (download the template first)' };
  }
  const docs = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || !row.some((c) => String(c).trim())) continue;
    const doc = {};
    Object.entries(columns).forEach(([key, { at, field }]) => {
      const raw = String(row[at] == null ? '' : row[at]).trim();
      if (field.t === 'money' || field.t === 'pct') {
        const cleaned = raw.replace(/[₹,\s]/g, '');
        doc[key] = cleaned === '' ? 0 : Number(cleaned) || 0;
      } else if (field.t === 'date') {
        doc[key] = normaliseDate(raw);
      } else {
        doc[key] = raw;
      }
    });
    docs.push(doc);
  }
  if (!docs.length) return { docs: [], error: 'No data rows found below the header' };
  return { docs };
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
