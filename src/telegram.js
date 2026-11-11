// Telegram: one shared bot, many households.
//
// The bot is a single Bot API application owned by the deployment, so there is no
// per-user token and no global "send everything to this chat id" shortcut. A chat
// only receives a household's alerts after the signed-in account linked it with a
// single-use code, and every send resolves its recipients from D1 at that moment:
// the link must still be live, the account must still be a member of the book the
// notification belongs to, and the account's preview preference decides how much
// of the message is included.
//
// Nothing here logs a token, a link code or a financial value.

import { HttpError } from './errors.js';

const API = 'https://api.telegram.org';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 4;
const GENERIC_TEXT = 'You have a new planner alert. Open the app to view it.';

/** A bot without a webhook secret can send but never receive, so it is not usable. */
export function telegramConfigured(env) {
  return Boolean(String(env.TELEGRAM_BOT_TOKEN || '').trim()) && telegramWebhookConfigured(env);
}

/**
 * The public @username of the shared bot. It is not a secret — it is what people
 * type into Telegram — so Settings can link straight to the chat instead of
 * sending them off to guess which bot the deployment uses.
 */
export function botUsername(env) {
  const raw = String(env.TELEGRAM_BOT_USERNAME || '')
    .trim()
    .replace(/^@/, '');
  return /^[A-Za-z0-9_]{4,32}$/.test(raw) ? raw : '';
}

export function telegramWebhookConfigured(env) {
  return Boolean(String(env.TELEGRAM_WEBHOOK_SECRET || '').trim());
}

/** What the Settings card shows instead of a button that cannot work. */
export function telegramMissing(env) {
  // Each name is checked on its own: reporting a secret the owner already set
  // sends them looking in the wrong place.
  const missing = [];
  if (!String(env.TELEGRAM_BOT_TOKEN || '').trim()) missing.push('TELEGRAM_BOT_TOKEN');
  if (!telegramWebhookConfigured(env)) missing.push('TELEGRAM_WEBHOOK_SECRET');
  return missing;
}

/* ------------------------------------------------------------------ codes */

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashCode(code, salt) {
  const data = new TextEncoder().encode(`${salt}:${String(code).toUpperCase()}`);
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Issue a link code for the signed-in account. Only the hash is stored, so the
 * code exists in exactly one place: the screen that shows it.
 */
export async function createLinkCode(env, userId) {
  const code = randomCode();
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  // A new code replaces any earlier unused one, so a leaked screenshot stops
  // working the moment a fresh code is asked for.
  await env.DB.prepare(`DELETE FROM telegram_codes WHERE user_id = ? AND used_at IS NULL`).bind(userId).run();
  await env.DB.prepare(
    `INSERT INTO telegram_codes (id, user_id, code_hash, salt, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, await hashCode(code, salt), salt, now + CODE_TTL_MS, now)
    .run();
  return { code, minutes: CODE_TTL_MS / 60_000 };
}

/**
 * Redeem a code for a Telegram identity. The code is consumed in the same
 * statement that checks it is still live, so two chats racing on one code cannot
 * both win.
 */
export async function consumeLinkCode(env, code, { telegramUserId, chatId, username }) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tgId = String(telegramUserId || '').replace(/\D/g, '');
  const chat = String(chatId || '').replace(/\D/g, '');
  if (!clean || !tgId || !chat) return { ok: false, reason: 'invalid' };

  const rows = (await env.DB.prepare(
    `SELECT id, user_id, code_hash, salt, expires_at FROM telegram_codes
      WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(Date.now())
    .all()).results || [];

  let match = null;
  for (const row of rows) {
    if ((await hashCode(clean, row.salt)) === row.code_hash) {
      match = row;
      break;
    }
  }
  if (!match) return { ok: false, reason: 'expired' };

  const claimed = await env.DB.prepare(
    `UPDATE telegram_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`,
  )
    .bind(Date.now(), match.id)
    .run();
  if (!((claimed.meta && claimed.meta.changes) || 0)) return { ok: false, reason: 'expired' };

  // One identity per account and one account per identity. A live link on either
  // side means the person must unlink first, which keeps a shared family phone
  // from silently taking over somebody else's alerts.
  const taken = await env.DB.prepare(
    `SELECT user_id, telegram_user_id FROM telegram_links
      WHERE revoked_at IS NULL AND (user_id = ? OR telegram_user_id = ?) LIMIT 1`,
  )
    .bind(match.user_id, tgId)
    .first();
  if (taken) {
    return {
      ok: false,
      reason: taken.user_id === match.user_id ? 'account-linked' : 'identity-linked',
    };
  }

  await env.DB.prepare(
    `INSERT INTO telegram_links (id, user_id, telegram_user_id, chat_id, username, preview, created_at)
     VALUES (?, ?, ?, ?, ?, 'generic', ?)`,
  )
    .bind(crypto.randomUUID(), match.user_id, tgId, chat, String(username || '').slice(0, 64) || null, Date.now())
    .run();
  return { ok: true, userId: match.user_id };
}

/* ------------------------------------------------------------------ links */

export async function linkForUser(env, userId) {
  return env.DB.prepare(
    `SELECT id, telegram_user_id, chat_id, username, preview, created_at, blocked_at
       FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(userId)
    .first();
}

export async function linkForTelegram(env, telegramUserId) {
  return env.DB.prepare(
    `SELECT * FROM telegram_links WHERE telegram_user_id = ? AND revoked_at IS NULL`,
  )
    .bind(String(telegramUserId).replace(/\D/g, ''))
    .first();
}

/** Revoking stops every future message to that chat, including queued ones. */
export async function unlinkTelegram(env, userId) {
  const now = Date.now();
  const link = await linkForUser(env, userId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE telegram_links SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now, userId),
    env.DB.prepare(
      `UPDATE telegram_deliveries SET status = 'failed', error = 'unlinked'
        WHERE status IN ('pending', 'retry') AND link_id = ?`,
    ).bind(link ? link.id : ''),
  ]);
  return Boolean(link);
}

export async function setPreview(env, userId, preview) {
  const value = preview === 'detailed' ? 'detailed' : 'generic';
  await env.DB.prepare(`UPDATE telegram_links SET preview = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(value, userId)
    .run();
  return value;
}

/* ------------------------------------------------------------------- send */

/**
 * One Bot API call. The token is never logged and never returned to a caller;
 * the status code is what the retry logic needs.
 */
export async function sendMessage(env, chatId, text, fetchImpl = fetch) {
  if (!telegramConfigured(env)) return { ok: false, status: 501, retryAfter: 0 };
  const res = await fetchImpl(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const retryAfter = Number(body && body.parameters && body.parameters.retry_after) || 0;
  return { ok: res.ok, status: res.status, retryAfter };
}

/** The text a linked account receives for one notification. */
export function renderNotification(link, notification) {
  if (link.preview !== 'detailed') return GENERIC_TEXT;
  const title = String(notification.title || '').slice(0, 200);
  const body = String(notification.body || '').slice(0, 300);
  return body ? `${title}\n${body}` : title;
}

/**
 * Queue a notification for delivery. Called from the write that created it, so
 * it is a single D1 insert and never a network call.
 */
export async function queueNotification(env, notification) {
  if (!telegramConfigured(env)) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO telegram_events (id, space, created_at) VALUES (?, ?, ?)`,
  )
    .bind(String(notification.id), String(notification.space || 'family'), Date.now())
    .run();
}

/**
 * Deliver whatever is due. Recipients are resolved here, not when the event was
 * queued: a link revoked in between receives nothing, and a member added later
 * does not receive history.
 */
export async function deliverPending(env, { limit = 20, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!telegramConfigured(env)) return { sent: 0, skipped: 0 };
  const events = (await env.DB.prepare(
    `SELECT id, space FROM telegram_events WHERE processed_at IS NULL ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all()).results || [];
  let sent = 0;
  let skipped = 0;

  for (const event of events) {
    const notification = await env.DB.prepare(`SELECT * FROM notifications WHERE id = ?`).bind(event.id).first();
    if (!notification) {
      await env.DB.prepare(`UPDATE telegram_events SET processed_at = ? WHERE id = ?`).bind(now, event.id).run();
      continue;
    }
    const members = (await env.DB.prepare(
      `SELECT user_id FROM profile_members WHERE profile_id = ?
        UNION SELECT owner_id FROM profiles WHERE id = ?`,
    )
      .bind(event.space, event.space)
      .all()).results || [];
    const userIds = members.map((m) => m.user_id).filter(Boolean);
    if (!userIds.length) {
      await env.DB.prepare(`UPDATE telegram_events SET processed_at = ? WHERE id = ?`).bind(now, event.id).run();
      continue;
    }
    const holes = userIds.map(() => '?').join(',');
    const links = (await env.DB.prepare(
      `SELECT * FROM telegram_links
        WHERE revoked_at IS NULL AND blocked_at IS NULL AND user_id IN (${holes})`,
    )
      .bind(...userIds)
      .all()).results || [];

    let pending = 0;
    for (const link of links) {
      // Claim the pair. A retried event cannot send the same alert twice.
      const claim = await env.DB.prepare(
        `INSERT OR IGNORE INTO telegram_deliveries (notification_id, link_id, status, attempts, next_try)
         VALUES (?, ?, 'pending', 0, 0)`,
      )
        .bind(event.id, link.id)
        .run();
      if (!((claim.meta && claim.meta.changes) || 0)) {
        const existing = await env.DB.prepare(
          `SELECT status, next_try FROM telegram_deliveries WHERE notification_id = ? AND link_id = ?`,
        )
          .bind(event.id, link.id)
          .first();
        if (!existing || existing.status === 'sent' || existing.status === 'failed' || existing.status === 'blocked') {
          skipped += 1;
          continue;
        }
        if (Number(existing.next_try) > now) {
          pending += 1;
          continue;
        }
      }

      const row = await env.DB.prepare(
        `SELECT attempts FROM telegram_deliveries WHERE notification_id = ? AND link_id = ?`,
      )
        .bind(event.id, link.id)
        .first();
      const attempts = Number(row && row.attempts) || 0;
      const result = await sendMessage(env, link.chat_id, renderNotification(link, notification), fetchImpl);

      if (result.ok) {
        sent += 1;
        await env.DB.prepare(
          `UPDATE telegram_deliveries SET status = 'sent', attempts = ?, sent_at = ?, error = NULL
            WHERE notification_id = ? AND link_id = ?`,
        )
          .bind(attempts + 1, now, event.id, link.id)
          .run();
        continue;
      }

      // 403: the person blocked the bot. Stop trying until they start it again.
      if (result.status === 403) {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE telegram_deliveries SET status = 'blocked', attempts = ?, error = 'blocked'
              WHERE notification_id = ? AND link_id = ?`,
          ).bind(attempts + 1, event.id, link.id),
          env.DB.prepare(`UPDATE telegram_links SET blocked_at = ? WHERE id = ?`).bind(now, link.id),
        ]);
        skipped += 1;
        continue;
      }
      // 400: the chat id is not usable (deleted chat, wrong id). Retrying cannot fix it.
      if (result.status === 400) {
        await env.DB.prepare(
          `UPDATE telegram_deliveries SET status = 'failed', attempts = ?, error = 'invalid-chat'
            WHERE notification_id = ? AND link_id = ?`,
        )
          .bind(attempts + 1, event.id, link.id)
          .run();
        skipped += 1;
        continue;
      }

      const nextAttempt = attempts + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await env.DB.prepare(
          `UPDATE telegram_deliveries SET status = 'failed', attempts = ?, error = ?
            WHERE notification_id = ? AND link_id = ?`,
        )
          .bind(nextAttempt, `status-${result.status}`, event.id, link.id)
          .run();
        skipped += 1;
        continue;
      }
      // 429 carries its own wait; anything else backs off exponentially.
      const wait = result.status === 429 && result.retryAfter
        ? result.retryAfter * 1000
        : Math.min(15 * 60_000, 30_000 * 2 ** attempts);
      await env.DB.prepare(
        `UPDATE telegram_deliveries SET status = 'retry', attempts = ?, next_try = ?, error = ?
          WHERE notification_id = ? AND link_id = ?`,
      )
        .bind(nextAttempt, now + wait, `status-${result.status}`, event.id, link.id)
        .run();
      pending += 1;
    }

    if (!pending) {
      await env.DB.prepare(`UPDATE telegram_events SET processed_at = ? WHERE id = ?`).bind(now, event.id).run();
    }
  }
  return { sent, skipped };
}

/* --------------------------------------------------------------- commands */

const HELP = [
  'Family Finance Planner',
  '',
  '/link CODE — connect this chat to your planner account',
  '/status — what this chat is connected to',
  '/settings — choose how much alerts show',
  '/unlink — stop all messages to this chat',
  '/help — this list',
].join('\n');

async function statusText(env, link) {
  const user = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`).bind(link.user_id).first();
  const books = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM profile_members WHERE user_id = ?`,
  )
    .bind(link.user_id)
    .first()) || { n: 0 };
  const unread = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications n
      WHERE n.read_at IS NULL AND n.space IN (SELECT profile_id FROM profile_members WHERE user_id = ?)`,
  )
    .bind(link.user_id)
    .first()) || { n: 0 };
  return [
    `Connected to ${user ? user.name : 'your planner'}.`,
    `Books: ${Number(books.n) || 0} · unread alerts: ${Number(unread.n) || 0}`,
    `Alerts show: ${link.preview === 'detailed' ? 'amounts and details' : 'a generic preview'}`,
  ].join('\n');
}

/**
 * Handle one Bot API update. Returns the reply text, or '' when the update needs
 * no answer. Never throws: the webhook answers 200 so Telegram stops retrying.
 */
export async function handleUpdate(env, update) {
  const message = update && (update.message || update.edited_message);
  if (!message) return '';
  const chat = message.chat || {};
  // Group chats are refused: a link belongs to one person's private chat.
  if (chat.type !== 'private') return 'This bot only works in a private chat.';
  const telegramUserId = String((message.from && message.from.id) || chat.id || '').replace(/\D/g, '');
  const chatId = String(chat.id || '').replace(/\D/g, '');
  if (!telegramUserId || !chatId) return '';

  const text = String(message.text || '').trim();
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, '');
  const argument = rest.join(' ').trim();

  if (command === '/start' || command === '/help' || command === '') {
    const link = await linkForTelegram(env, telegramUserId);
    if (link && link.blocked_at) {
      await env.DB.prepare(`UPDATE telegram_links SET blocked_at = NULL WHERE id = ?`).bind(link.id).run();
    }
    return link
      ? `${HELP}\n\nThis chat is already connected.`
      : `${HELP}\n\nTo connect: open the planner → Settings → Notifications → Connect Telegram, then send /link CODE here.`;
  }

  if (command === '/link') {
    const code = argument || '';
    if (!code) return 'Send /link CODE with the code shown in the planner.';
    const out = await consumeLinkCode(env, code, {
      telegramUserId,
      chatId,
      username: message.from && message.from.username,
    });
    if (out.ok) return 'Connected. You will get planner alerts in this chat. Send /settings to choose how much they show.';
    if (out.reason === 'account-linked') return 'That planner account is already connected to a Telegram chat. Send /unlink there first.';
    if (out.reason === 'identity-linked') return 'This Telegram account is already connected to a planner. Send /unlink first.';
    return 'That code is not valid or has expired. Create a new one in the planner.';
  }

  const link = await linkForTelegram(env, telegramUserId);
  if (!link) return 'This chat is not connected yet. Open the planner → Settings → Notifications → Connect Telegram.';

  if (command === '/status') return statusText(env, link);

  if (command === '/settings') {
    const choice = argument.toLowerCase();
    if (choice === 'generic' || choice === 'detailed') {
      const preview = await setPreview(env, link.user_id, choice);
      return preview === 'detailed'
        ? 'Alerts will include amounts and details.'
        : 'Alerts will show a generic preview.';
    }
    return [
      `Alerts show: ${link.preview === 'detailed' ? 'amounts and details' : 'a generic preview'}`,
      '',
      'Send /settings generic — “You have a new planner alert.”',
      'Send /settings detailed — include the title and amount.',
    ].join('\n');
  }

  if (command === '/unlink') {
    await unlinkTelegram(env, link.user_id);
    return 'Disconnected. This chat will not receive any more planner messages.';
  }

  // A bare code is the most likely thing someone pastes, so accept it.
  if (/^[A-Z0-9]{8,12}$/i.test(text)) {
    const out = await consumeLinkCode(env, text, {
      telegramUserId,
      chatId,
      username: message.from && message.from.username,
    });
    if (out.ok) return 'Connected. You will get planner alerts in this chat.';
  }
  return 'Unknown command. Send /help to see what this bot can do.';
}

/** Reject anything that is not the deployment's own webhook secret. */
export function webhookSecretOk(env, header) {
  const expected = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!expected) return false;
  const given = String(header || '').trim();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function assertTelegramConfigured(env) {
  if (!telegramConfigured(env)) {
    throw new HttpError(
      501,
      `Telegram is not configured. Add ${telegramMissing(env).join(' and ')} as Worker secrets.`,
    );
  }
}
