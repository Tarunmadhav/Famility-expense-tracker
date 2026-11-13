// Google Calendar sync for tasks that have a due time.
//
// The scope is `calendar.app.created`, which Google documents as "Make secondary
// Google calendars, and see, create, change, and delete events on them". That is
// the whole permission: the app can only reach the calendar it created itself, so
// it cannot read or change any other calendar in the account.
//
// A connection is: PKCE + single-use state against Google, a refresh token sealed
// by src/backupcrypto.js before it reaches D1, a calendar named
// "Family Finance Planner", and one mapping row per task so a re-sync patches the
// existing event instead of creating a second one.
//
// Every Google call is made with an injected `fetchImpl`, so tests can stub the
// provider without a network.

import { HttpError } from './errors.js';
import { openToken, sealToken } from './backupcrypto.js';
import { b64url, getMeta, setMeta } from './store.js';
import { revealDoc } from './fieldcrypto.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const CALENDAR_NAME = 'Family Finance Planner';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
/** After this many failed attempts a mapping stops retrying and keeps its error. */
export const MAX_ATTEMPTS = 5;

/**
 * What the deployment is missing. Names only, never values, so Settings can say
 * exactly which setting the owner still has to add.
 */
export function calendarConfig(env) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'BACKUP_KEY'].filter((key) => !env[key]);
  return { configured: missing.length === 0, missing, scope: CALENDAR_SCOPE };
}

function provider(env) {
  const config = calendarConfig(env);
  if (!config.configured) {
    throw new HttpError(
      501,
      `Calendar sync is not set up: owner action needed (${config.missing.join(', ')}).`,
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  };
}

/** Step 1: PKCE verifier + single-use state, tied to the account and the book. */
export async function startCalendarConnect(env, { userId, profileId, redirectUri }) {
  const creds = provider(env);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await setMeta(env, `calstate:${state}`, { userId, profileId, verifier, redirectUri, at: Date.now() });
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', `${CALENDAR_SCOPE} openid email`);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', b64url(new Uint8Array(digest)));
  url.searchParams.set('code_challenge_method', 'S256');
  // offline gets a refresh token; consent+select_account makes Google actually
  // show the picker on a phone that has more than one account signed in.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  return { url: url.toString(), state };
}

/** Step 2: exchange the code and seal the refresh token. */
export async function finishCalendarConnect(env, code, state, fetchImpl = fetch) {
  const creds = provider(env);
  const pending = await getMeta(env, `calstate:${state}`, null);
  if (!pending || !pending.at || Date.now() - pending.at > 600_000) {
    throw new HttpError(400, 'That calendar link has expired');
  }
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  const res = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) throw new HttpError(400, 'Google did not accept the calendar connection');
  if (!data.refresh_token) {
    throw new HttpError(400, 'Google did not return a refresh token. Remove the app access and connect again.');
  }
  // Single use: the state is burned whether or not the caller keeps the result.
  await setMeta(env, `calstate:${state}`, null);
  return {
    userId: pending.userId,
    profileId: pending.profileId,
    sealedRefresh: await sealToken(env, data.refresh_token),
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

export async function calendarRow(env, space) {
  return (
    (await env.DB.prepare(
      `SELECT profile_id, user_id, calendar_id, refresh_token, access_token, expires_at, detail, last_error, last_error_at
         FROM google_calendars WHERE profile_id = ?`,
    )
      .bind(space)
      .first()) || null
  );
}

/** The mapping row for one task, or null. */
export async function eventRow(env, space, recordId) {
  return (
    (await env.DB.prepare(
      `SELECT event_id, attempts, next_try, error FROM google_events
        WHERE space = ? AND collection = 'diary' AND record_id = ?`,
    )
      .bind(space, recordId)
      .first()) || null
  );
}

async function accessToken(env, conn, fetchImpl) {
  if (conn.access_token && conn.expires_at && Number(conn.expires_at) > Date.now() + 60_000) {
    return conn.access_token;
  }
  const creds = provider(env);
  const refresh = await openToken(env, conn.refresh_token);
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refresh,
  });
  const res = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new Error('The calendar connection expired. Reconnect it in Settings.');
  }
  await env.DB.prepare(`UPDATE google_calendars SET access_token = ?, expires_at = ? WHERE profile_id = ?`)
    .bind(data.access_token, Date.now() + (Number(data.expires_in) || 3600) * 1000, conn.profile_id)
    .run();
  return data.access_token;
}

async function google(env, conn, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const token = await accessToken(env, conn, fetchImpl);
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/** Create the app's own calendar once, then remember its id. */
export async function ensureCalendar(env, conn, fetchImpl = fetch) {
  if (conn.calendar_id) return conn.calendar_id;
  const out = await google(env, conn, '/calendars', {
    method: 'POST',
    body: { summary: CALENDAR_NAME, timeZone: 'UTC' },
    fetchImpl,
  });
  if (!out.ok || !out.data || !out.data.id) {
    throw new Error(`Google Calendar refused to create the calendar (HTTP ${out.status})`);
  }
  await env.DB.prepare(`UPDATE google_calendars SET calendar_id = ? WHERE profile_id = ?`)
    .bind(out.data.id, conn.profile_id)
    .run();
  conn.calendar_id = out.data.id;
  return out.data.id;
}

function eventBody(doc, detail) {
  const start = new Date(String(doc.dueAt || ''));
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const lines = [];
  if (doc.dueTime) lines.push(`Due at ${doc.dueTime}`);
  if (doc.notes) lines.push(String(doc.notes).slice(0, 800));
  if (doc.priority) lines.push(`Priority: ${doc.priority}`);
  // Money is only ever written when the person turned detail on, and only when
  // the task actually carries an amount.
  if (detail && doc.amount !== '' && doc.amount != null && Number.isFinite(Number(doc.amount))) {
    lines.push(`Amount: ${Number(doc.amount)}`);
  }
  lines.push('Added by Family Finance Planner');
  return {
    summary: `Task due: ${String(doc.title || 'Task').slice(0, 120)}`,
    description: lines.join('\n'),
    start: { dateTime: start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: end.toISOString(), timeZone: 'UTC' },
  };
}

async function clearMapping(env, space, recordId) {
  await env.DB.prepare(`DELETE FROM google_events WHERE space = ? AND collection = 'diary' AND record_id = ?`)
    .bind(space, recordId)
    .run();
}

async function rememberAttempt(env, space, recordId, { eventId, error, attempts, nextTry }) {
  await env.DB.prepare(
    `INSERT INTO google_events (space, collection, record_id, event_id, attempts, next_try, error, updated_at)
     VALUES (?, 'diary', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(space, collection, record_id) DO UPDATE SET
       event_id = excluded.event_id, attempts = excluded.attempts,
       next_try = excluded.next_try, error = excluded.error, updated_at = excluded.updated_at`,
  )
    .bind(space, recordId, eventId || null, attempts, nextTry, error || null, Date.now())
    .run();
}

async function removeEvent(env, conn, eventId, fetchImpl) {
  const out = await google(env, conn, `/calendars/${encodeURIComponent(conn.calendar_id)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    fetchImpl,
  });
  // 404/410: already gone, which is the state the caller wanted.
  if (!out.ok && out.status !== 404 && out.status !== 410) {
    throw new Error(`Google Calendar could not delete the event (HTTP ${out.status})`);
  }
}

/**
 * Bring Google's copy of one task up to date.
 *
 * `doc` is the revealed task document (the same object the API returns); `op` is
 * 'delete' when the task itself was deleted. Returns a small status so the caller
 * can log without leaking task content.
 */
export async function syncTask(env, { space, recordId, doc = null, op = 'upsert', fetchImpl = fetch, now = Date.now() }) {
  if (!calendarConfig(env).configured) return { status: 'unconfigured' };
  const conn = await calendarRow(env, space);
  if (!conn) return { status: 'not-connected' };
  const existing = await eventRow(env, space, recordId);

  const wanted = op !== 'delete' && doc && doc.dueAt && doc.status !== 'Completed';
  try {
    await ensureCalendar(env, conn, fetchImpl);
    if (!wanted) {
      if (existing && existing.event_id) await removeEvent(env, conn, existing.event_id, fetchImpl);
      await clearMapping(env, space, recordId);
      return { status: op === 'delete' ? 'deleted' : 'not-due' };
    }
    const body = eventBody(doc, Number(conn.detail) === 1);
    if (existing && existing.event_id) {
      const patched = await google(
        env,
        conn,
        `/calendars/${encodeURIComponent(conn.calendar_id)}/events/${encodeURIComponent(existing.event_id)}`,
        { method: 'PATCH', body, fetchImpl },
      );
      if (patched.ok) {
        await rememberAttempt(env, space, recordId, { eventId: existing.event_id, attempts: 0, nextTry: 0 });
        return { status: 'updated' };
      }
      // A deleted event makes PATCH answer 404; forget the id and insert instead
      // rather than retrying against something that no longer exists.
      if (patched.status !== 404 && patched.status !== 410) {
        throw new Error(`Google Calendar rejected the update (HTTP ${patched.status})`);
      }
    }
    const created = await google(env, conn, `/calendars/${encodeURIComponent(conn.calendar_id)}/events`, {
      method: 'POST',
      body,
      fetchImpl,
    });
    if (!created.ok || !created.data || !created.data.id) {
      throw new Error(`Google Calendar rejected the event (HTTP ${created.status})`);
    }
    await rememberAttempt(env, space, recordId, { eventId: created.data.id, attempts: 0, nextTry: 0 });
    return { status: 'created', eventId: created.data.id };
  } catch (err) {
    // 429 and 5xx are worth retrying; a rejected scope or a dead token is not, but
    // the mapping keeps the message either way so Settings can show it.
    const attempts = Number((existing && existing.attempts) || 0) + 1;
    const wait = Math.min(60, 2 ** attempts) * 60_000;
    await rememberAttempt(env, space, recordId, {
      eventId: existing ? existing.event_id : null,
      error: String((err && err.message) || 'Google Calendar sync failed').slice(0, 200),
      attempts: attempts > MAX_ATTEMPTS ? MAX_ATTEMPTS : attempts,
      nextTry: attempts >= MAX_ATTEMPTS ? 0 : now + wait,
    });
    await env.DB.prepare(`UPDATE google_calendars SET last_error = ?, last_error_at = ? WHERE profile_id = ?`)
      .bind(String((err && err.message) || 'sync failed').slice(0, 200), Date.now(), space)
      .run();
    return { status: 'failed', error: String((err && err.message) || '') };
  }
}

/**
 * Cron: retry the mappings that are due, in backoff order. A mapping that used up
 * MAX_ATTEMPTS is skipped and keeps its last error for Settings.
 */
export async function retryCalendarSync(env, { now = Date.now(), fetchImpl = fetch, limit = 20 } = {}) {
  if (!calendarConfig(env).configured) return { retried: 0, skipped: 'unconfigured' };
  const due = await env.DB.prepare(
    `SELECT space, record_id FROM google_events
      WHERE attempts > 0 AND attempts < ? AND next_try > 0 AND next_try <= ?
      ORDER BY next_try LIMIT ?`,
  )
    .bind(MAX_ATTEMPTS, now, limit)
    .all();
  let retried = 0;
  for (const row of due.results || []) {
    const stored = await env.DB.prepare(
      `SELECT doc FROM records WHERE space = ? AND collection = 'diary' AND id = ?`,
    )
      .bind(row.space, row.record_id)
      .first();
    let doc = null;
    if (stored) {
      try {
        // Fields the app seals at rest are revealed here, exactly as the API
        // does, so an event never carries ciphertext into a title or note.
        doc = await revealDoc(env, 'diary', JSON.parse(stored.doc));
      } catch {
        doc = null;
      }
    }
    // A task that vanished while a retry was pending is treated as a delete.
    await syncTask(env, {
      space: row.space,
      recordId: row.record_id,
      doc,
      op: doc ? 'upsert' : 'delete',
      fetchImpl,
      now,
    });
    retried += 1;
  }
  return { retried };
}

/** Disconnect: revoke at Google, forget the token and the mapping. Events stay. */
export async function unlinkCalendar(env, space, fetchImpl = fetch) {
  const conn = await calendarRow(env, space);
  if (!conn) return { unlinked: false };
  let revoked = false;
  try {
    const refresh = await openToken(env, conn.refresh_token);
    const res = await fetchImpl(`${REVOKE}?token=${encodeURIComponent(refresh)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    // 400 means the token was already invalid, which is the outcome we want.
    revoked = res.ok || res.status === 400;
  } catch {
    revoked = false;
  }
  await env.DB.prepare(`DELETE FROM google_events WHERE space = ?`).bind(space).run();
  await env.DB.prepare(`DELETE FROM google_calendars WHERE profile_id = ?`).bind(space).run();
  return { unlinked: true, revoked };
}

export async function setCalendarDetail(env, space, detail) {
  await env.DB.prepare(`UPDATE google_calendars SET detail = ? WHERE profile_id = ?`)
    .bind(detail ? 1 : 0, space)
    .run();
  return { detail: detail ? 1 : 0 };
}
