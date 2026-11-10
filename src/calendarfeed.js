// A calendar you can subscribe to instead of downloading a file.
//
// Google Calendar, Apple Calendar, Outlook, Thunderbird, Nextcloud and anything
// else that speaks iCalendar fetch a URL like
//   https://<worker>/api/calendar/<token>.ics
// on their own schedule and refresh the events in place. The token is the whole
// credential: no cookie is sent by a calendar client, so the route is public but
// unguessable, and rotating the token from Settings revokes the old URL.
//
// Events are all-day so no timezone conversion can shift a bill onto the wrong
// day, and every UID is derived from the record id so a refresh updates an event
// instead of duplicating it.

const TOKEN_ALPHABET = '0123456789abcdef';
const FEED_COLLECTIONS = ['diary', 'payments', 'insurance', 'subscriptions'];

export function newFeedToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = '';
  for (const byte of bytes) out += TOKEN_ALPHABET[byte >> 4] + TOKEN_ALPHABET[byte & 15];
  return out;
}

/**
 * The feed token for one book, created on first use unless `rotate` retires it.
 * The token is bound to the profile, so a calendar subscribed to the household
 * book can never show the Office or Personal book.
 */
export async function calendarToken(env, userId, profileId, { rotate = false } = {}) {
  const existing = await env.DB.prepare('SELECT token FROM calendar_feeds WHERE user_id = ? AND profile_id = ?')
    .bind(userId, profileId)
    .first();
  if (existing && !rotate) return existing.token;
  const token = newFeedToken();
  await env.DB.prepare(
    `INSERT INTO calendar_feeds (user_id, profile_id, token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, profile_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
  )
    .bind(userId, profileId, token, Date.now())
    .run();
  return token;
}

/** `{ userId, profileId }` behind a token, or null when it is unknown or revoked. */
export async function accountForFeedToken(env, token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  const row = await env.DB.prepare('SELECT user_id, profile_id FROM calendar_feeds WHERE token = ?')
    .bind(token)
    .first();
  return row && row.profile_id ? { userId: row.user_id, profileId: row.profile_id } : null;
}

/* ------------------------------------------------------------- iCalendar */

// RFC 5545: escape backslash, semicolon, comma and newline; fold long lines at
// 75 octets so a long policy name cannot corrupt the file.
function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function fold(line) {
  const out = [];
  let rest = line;
  let limit = 74;
  while (rest.length > limit) {
    out.push(rest.slice(0, limit));
    rest = rest.slice(limit);
    limit = 73; // continuation lines start with a space
  }
  out.push(rest);
  return out.join('\r\n ');
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '');

function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const p = (n) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${p(next.getUTCMonth() + 1)}-${p(next.getUTCDate())}`;
}

const compact = (iso) => iso.replace(/-/g, '');

/**
 * Events for every book the account can open. `spaces` are profile ids that were
 * already checked against membership by the caller.
 */
export async function collectEvents(env, spaces) {
  if (!spaces.length) return [];
  const placeholders = spaces.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT space, collection, id, doc FROM records
      WHERE space IN (${placeholders}) AND collection IN (${FEED_COLLECTIONS.map(() => '?').join(',')})`,
  )
    .bind(...spaces, ...FEED_COLLECTIONS)
    .all();

  const events = [];
  for (const row of rows.results || []) {
    let doc;
    try {
      doc = JSON.parse(row.doc);
    } catch {
      continue;
    }
    const push = (uid, when, summary, description, alarms) => {
      const date = isoDate(when);
      if (!date) return;
      events.push({ uid: `${row.space}-${uid}`, date, summary, description, alarms });
    };

    if (row.collection === 'diary') {
      if (String(doc.status || '') === 'Completed') continue;
      push(
        `task-${row.id}`,
        doc.date,
        `Task: ${doc.title || 'Untitled task'}`,
        [doc.notes, doc.follow ? `Follow-up: ${doc.follow}` : '', doc.contact ? `Contact: ${doc.contact} ${doc.phone || ''}` : '']
          .filter(Boolean)
          .join('\n'),
        [1440, 0],
      );
    } else if (row.collection === 'payments') {
      if (String(doc.status || '') === 'Paid') continue;
      push(
        `bill-${row.id}`,
        doc.due,
        `Bill due: ${doc.payee || 'Payment'} ${doc.amount ? `(${Number(doc.amount)})` : ''}`.trim(),
        [doc.bill || doc.item || '', doc.status ? `Status: ${doc.status}` : ''].filter(Boolean).join('\n'),
        [4320, 1440, 0],
      );
    } else if (row.collection === 'insurance') {
      push(
        `policy-${row.id}`,
        doc.renewal,
        `Insurance renewal: ${doc.name || 'Policy'}`,
        [doc.insurer ? `Insurer: ${doc.insurer}` : '', doc.premium ? `Premium: ${doc.premium}` : '', doc.policyno ? `Policy no: ${doc.policyno}` : '']
          .filter(Boolean)
          .join('\n'),
        [43200, 21600, 10080, 1440],
      );
    } else if (row.collection === 'subscriptions') {
      if (String(doc.status || 'Active') === 'Cancelled') continue;
      push(
        `sub-${row.id}`,
        doc.nextDue,
        `Subscription renewal: ${doc.service || 'Subscription'}`,
        [doc.plan ? `Plan: ${doc.plan}` : '', doc.amount ? `Amount: ${doc.amount}` : ''].filter(Boolean).join('\n'),
        [4320, 1440],
      );
    }
  }
  return events;
}

export function renderIcs(events, { name = 'Family Finance Planner' } = {}) {
  const dtstamp = stampNow();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Finance Planner//Calendar feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Asia/Kolkata',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${event.uid}@family-finance-planner`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${compact(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compact(nextDay(event.date))}`);
    lines.push(fold(`SUMMARY:${escapeText(event.summary)}`));
    if (event.description) lines.push(fold(`DESCRIPTION:${escapeText(event.description)}`));
    for (const minutes of event.alarms || []) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:-PT${minutes}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/** The feed for one token, or null when the token is unknown or revoked. */
export async function calendarFeed(env, token) {
  const account = await accountForFeedToken(env, token);
  if (!account) return null;
  // Access is re-checked on every fetch: losing membership revokes the feed even
  // when the calendar still holds the old URL.
  const member = await env.DB.prepare('SELECT role FROM profile_members WHERE user_id = ? AND profile_id = ?')
    .bind(account.userId, account.profileId)
    .first();
  if (!member) return null;
  const profile = await env.DB.prepare('SELECT name FROM profiles WHERE id = ?').bind(account.profileId).first();
  const events = await collectEvents(env, [account.profileId]);
  return renderIcs(events, { name: profile?.name ? `${profile.name} · Family Finance Planner` : 'Family Finance Planner' });
}
