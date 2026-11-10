// WhatsApp interface: read, add, change and remove planner records from a chat.
//
// Inbound: Meta WhatsApp Cloud API posts to /api/whatsapp/webhook. Every request
// carries X-Hub-Signature-256, an HMAC of the raw body keyed with the app secret,
// and nothing is parsed before that check passes. A number is only allowed to touch
// a book once it has been linked from the signed-in app with a one-time code.
//
// Outbound: replies go through the Graph API. When the sending credentials are
// absent the command still runs and the reply is dropped with a log line, so a
// deployment without WhatsApp configured behaves the same as one that lost its
// token, instead of silently accepting writes with no answer.

import { COLLECTIONS } from '../web/src/entities.js';
import { HttpError } from './errors.js';
import { resolveProfile } from './profiles.js';
import { listProfiles } from './profiles.js';
import {
  createRecord,
  deleteRecord,
  consumeWhatsappCode,
  listCollection,
  setWhatsappProfile,
  setWhatsappState,
  unlinkWhatsapp,
  updateRecord,
  whatsappLink,
  whatsappState,
} from './store.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_REPLY = 3500;

/* --------------------------------------------------------------- config */

export function whatsappConfigured(env) {
  return Boolean(String(env.WHATSAPP_TOKEN || '').trim() && String(env.WHATSAPP_PHONE_ID || '').trim());
}

function missingConfig(env) {
  const missing = [];
  if (!String(env.WHATSAPP_TOKEN || '').trim()) missing.push('WHATSAPP_TOKEN');
  if (!String(env.WHATSAPP_PHONE_ID || '').trim()) missing.push('WHATSAPP_PHONE_ID');
  return missing;
}

/* ------------------------------------------------------------- signature */

const enc = new TextEncoder();

/** Timing-safe compare of the hex digest Meta sends with the one we compute. */
export async function verifySignature(env, rawBody, header) {
  const secret = String(env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret) return false;
  const value = String(header || '');
  if (!value.startsWith('sha256=')) return false;
  const given = value.slice(7).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody));
  let hex = '';
  for (let i = 0; i < digest.length; i += 1) hex += digest[i].toString(16).padStart(2, '0');
  // Constant time over the full digest.
  let diff = hex.length === given.length ? 0 : 1;
  for (let i = 0; i < hex.length; i += 1) diff |= hex.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

/** Flatten a webhook payload into the text messages it carries. */
export function parseWebhook(body) {
  const out = [];
  const entries = (body && Array.isArray(body.entry) && body.entry) || [];
  for (const entry of entries) {
    const changes = (entry && Array.isArray(entry.changes) && entry.changes) || [];
    for (const change of changes) {
      const value = change && change.value;
      if (!value) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const names = new Map(contacts.map((c) => [c.wa_id, (c.profile && c.profile.name) || '']));
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        if (!message || message.type !== 'text' || !message.text) continue;
        out.push({
          id: String(message.id || ''),
          from: String(message.from || '').replace(/\D/g, ''),
          name: names.get(message.from) || '',
          text: String(message.text.body || '').slice(0, 2000),
        });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- sending */

export async function sendWhatsapp(env, to, body) {
  if (!whatsappConfigured(env)) {
    console.warn('whatsapp reply skipped: missing', missingConfig(env).join(', '));
    return { skipped: true };
  }
  const text = String(body || '').slice(0, MAX_REPLY);
  const res = await fetch(`${GRAPH}/${encodeURIComponent(String(env.WHATSAPP_PHONE_ID).trim())}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(env.WHATSAPP_TOKEN).trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(to).replace(/\D/g, ''),
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('whatsapp send failed', res.status, detail.slice(0, 300));
  }
  return { ok: res.ok };
}

/* --------------------------------------------------- outbound notifications */

/**
 * Proactive messages (bills due tomorrow, a renewal reminder) are not replies: Meta
 * only delivers them as an approved template, and only when the business opted in.
 * The switch is the WHATSAPP_MESSAGING flag, so a deployment can hold the credentials
 * without anything leaving the Worker until someone turns it on.
 */
export function whatsappMessagingConfigured(env) {
  return (
    String(env.WHATSAPP_MESSAGING || '').trim().toLowerCase() === 'on' &&
    whatsappConfigured(env) &&
    Boolean(String(env.WHATSAPP_TEMPLATE || '').trim())
  );
}

/** What is still missing, named, so the settings screen can say it out loud. */
export function whatsappMessagingMissing(env) {
  const missing = [];
  if (String(env.WHATSAPP_MESSAGING || '').trim().toLowerCase() !== 'on') missing.push('WHATSAPP_MESSAGING=on');
  if (!String(env.WHATSAPP_TOKEN || '').trim()) missing.push('WHATSAPP_TOKEN');
  if (!String(env.WHATSAPP_PHONE_ID || '').trim()) missing.push('WHATSAPP_PHONE_ID');
  if (!String(env.WHATSAPP_TEMPLATE || '').trim()) missing.push('WHATSAPP_TEMPLATE');
  return missing;
}

/**
 * Send one approved-template notification. Never throws and never fakes success:
 * an unconfigured deployment answers `{ ok: false, reason: 'not-configured' }` and
 * makes no network call at all.
 */
export async function sendWhatsappTemplate(env, to, { template, params = [], language = 'en' } = {}) {
  if (!whatsappMessagingConfigured(env)) {
    return { ok: false, reason: 'not-configured', missing: whatsappMessagingMissing(env) };
  }
  // Stored numbers are E.164 and always carry the +. A bare national number is
  // ambiguous, so it is refused instead of being sent to a guessed country.
  const typed = String(to || '').trim();
  const digits = typed.replace(/\D/g, '');
  if (!typed.startsWith('+') || !/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, reason: 'bad-number' };
  const name = String(template || env.WHATSAPP_TEMPLATE || '').trim();
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(String(env.WHATSAPP_PHONE_ID).trim())}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.WHATSAPP_TOKEN).trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: digits,
        type: 'template',
        template: {
          name,
          language: { code: String(language || 'en') },
          components: params.length
            ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p).slice(0, 200) })) }]
            : [],
        },
      }),
    });
    if (!res.ok) {
      // The body can echo the recipient, never the token: log it truncated only.
      const detail = await res.text().catch(() => '');
      console.error('whatsapp template send failed', res.status, detail.slice(0, 200));
      return { ok: false, reason: `provider-${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('whatsapp template send error', String(err && err.message).slice(0, 160));
    return { ok: false, reason: 'network' };
  }
}

/* --------------------------------------------------------------- helpers */

const ALIASES = {
  task: 'diary',
  tasks: 'diary',
  todo: 'diary',
  todos: 'diary',
  note: 'diary',
  diary: 'diary',
  today: 'diary',
  bill: 'payments',
  bills: 'payments',
  payment: 'payments',
  payments: 'payments',
  expense: 'expenses',
  expenses: 'expenses',
  spend: 'expenses',
  spending: 'expenses',
  sub: 'subscriptions',
  subs: 'subscriptions',
  subscription: 'subscriptions',
  subscriptions: 'subscriptions',
  loan: 'loans',
  loans: 'loans',
  insurance: 'insurance',
  policy: 'insurance',
  family: 'family',
  contact: 'contacts',
  contacts: 'contacts',
  budget: 'budgetEx',
  income: 'budgetIn',
};

/** The one free-text field each collection understands without `key=value`. */
const MAIN_FIELD = {
  expenses: 'item',
  diary: 'title',
  payments: 'payee',
  subscriptions: 'service',
  loans: 'name',
  insurance: 'name',
  family: 'name',
  contacts: 'name',
  budgetIn: 'source',
  budgetEx: 'source',
};

const MONEY_FIELD = {
  expenses: 'amount',
  payments: 'amount',
  subscriptions: 'amount',
  loans: 'principal',
  insurance: 'premium',
  budgetIn: 'planned',
  budgetEx: 'planned',
};

const DATE_FIELD = {
  expenses: 'date',
  diary: 'date',
  payments: 'due',
  subscriptions: 'nextDue',
  insurance: 'renewal',
};

const OPEN_STATUS = { expenses: 'Paid', payments: 'Paid', diary: 'Done', subscriptions: 'Active', loans: 'Active' };

function money(value) {
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return '₹0';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function isoToday(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function readDate(word, fallback) {
  const w = String(word || '').toLowerCase();
  if (!w) return fallback;
  if (w === 'today') return isoToday(0);
  if (w === 'tomorrow') return isoToday(1);
  if (w === 'yesterday') return isoToday(-1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const dmy = w.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (dmy) {
    const year = dmy[3] ? (dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : String(new Date().getFullYear());
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return fallback;
}

function collectionOf(word) {
  const key = String(word || '').toLowerCase();
  return ALIASES[key] || (COLLECTIONS[key] ? key : '');
}

function rowLine(index, collection, row) {
  const main = row[MAIN_FIELD[collection]] || row.name || row.txn || row.id || '';
  const amount = MONEY_FIELD[collection] ? ` ${money(row[MONEY_FIELD[collection]])}` : '';
  const when = DATE_FIELD[collection] && row[DATE_FIELD[collection]] ? ` · ${row[DATE_FIELD[collection]]}` : '';
  const state = row.status ? ` · ${row.status}` : '';
  return `${index}. ${String(main).slice(0, 60)}${amount}${when}${state}`;
}

const HELP = [
  'Family Planner — text me what you need.',
  '',
  '*Reading*',
  '• summary — this month at a glance',
  '• list expenses | list bills | list tasks',
  '• show expenses 3 — full record',
  '',
  '*Writing*',
  '• add expense 250 groceries',
  '• add task Pay electricity bill tomorrow',
  '• add bill 1200 electricity due=2026-11-12',
  '• add expenses amount=90 item=Tea cat=Food',
  '• done 2 — close the 2nd row of the last list',
  '• edit bills 2 amount=1300 status=Paid',
  '• delete tasks 4',
  '',
  '*Anything else*',
  'Every collection works the same way: family, contacts, insurance,',
  'loans, subscriptions, budget, income. Use key=value for any field.',
  '',
  '*This chat*',
  '• profile — which book you are writing into',
  '• use personal | use family — switch book',
  '• unlink — stop this number from reaching the planner',
].join('\n');

/* -------------------------------------------------------------- commands */

async function linkReply(env, phone, code) {
  const pending = await consumeWhatsappCode(env, code, phone);
  if (!pending) return 'That code is wrong or has expired. Open Settings → WhatsApp in the app and create a new one.';
  const rows = await listProfiles(env, pending.userId);
  const profile = rows.find((r) => r.id === pending.profile) || rows[0];
  return `Linked. This chat now writes to *${profile ? profile.name : 'your planner'}*.\nSend *help* to see what I can do.`;
}

async function resolveChat(env, link) {
  // The link stores the book chosen at link time; membership is still re-checked on
  // every command, so a removed member loses access immediately.
  const rows = await listProfiles(env, link.user_id);
  const profile = rows.find((r) => r.id === link.profile) || rows[0];
  if (!profile) throw new HttpError(404, 'No planner is available for this account');
  return { rows, profile };
}

function sessionFor(link, profile) {
  return { userId: link.user_id, household: profile.id, name: 'WhatsApp' };
}

async function summary(env, link, profile) {
  const session = sessionFor(link, profile);
  const space = await resolveProfile(env, session, profile.id, 'view');
  const month = isoToday().slice(0, 7);
  const [expenses, payments, diary] = await Promise.all([
    listCollection(env, space.id, 'expenses'),
    listCollection(env, space.id, 'payments'),
    listCollection(env, space.id, 'diary'),
  ]);
  const spent = expenses
    .filter((e) => String(e.date || '').startsWith(month))
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const unpaid = payments.filter((p) => String(p.status || '').toLowerCase() !== 'paid');
  const owed = unpaid.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const soon = unpaid.filter((p) => p.due && p.due <= isoToday(14)).slice(0, 3);
  const openTasks = diary.filter((d) => String(d.status || '').toLowerCase() !== 'done');
  return [
    `*${profile.name}*`,
    `Spent this month: ${money(spent)} (${expenses.filter((e) => String(e.date || '').startsWith(month)).length} entries)`,
    `Unpaid bills: ${unpaid.length} · ${money(owed)}`,
    ...soon.map((p) => `  • ${p.payee || p.txn || 'Bill'} ${money(p.amount)} due ${p.due}`),
    `Open tasks: ${openTasks.length}`,
    ...openTasks.slice(0, 3).map((d, i) => `  ${i + 1}. ${String(d.title || '').slice(0, 50)}`),
  ].join('\n');
}

async function listReply(env, link, profile, collection, limit) {
  const space = await resolveProfile(env, sessionFor(link, profile), profile.id, 'view');
  const rows = await listCollection(env, space.id, collection);
  if (!rows.length) return `No ${COLLECTIONS[collection].label.toLowerCase()} yet.`;
  const shown = rows.slice(-limit);
  const ids = shown.map((r) => r.id);
  await setWhatsappState(env, link.phone, collection, ids);
  const ordered = shown.reverse();
  return [
    `*${COLLECTIONS[collection].label}* (${rows.length})`,
    ...ordered.map((row, i) => rowLine(i + 1, collection, row)),
    '',
    'Reply "done 1", "edit 1 field=value" or "delete 1".',
  ].join('\n');
}

/** Turn "3" or a raw record id into the record the user means. */
async function target(env, phone, collection, ref) {
  const token = String(ref || '').trim();
  if (!token) return null;
  const space = await whatsappState(env, phone);
  if (/^\d{1,3}$/.test(token)) {
    const index = Number(token) - 1;
    if (!space || space.collection !== collection || !space.ids[index]) return null;
    return space.ids[index];
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(token) ? token : null;
}

function parsePairs(tokens) {
  const pairs = {};
  const words = [];
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0 && eq < token.length - 1) {
      pairs[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1);
    } else {
      words.push(token);
    }
  }
  return { pairs, words };
}

function fieldsOnly(collection, pairs) {
  const allowed = new Set(COLLECTIONS[collection].fields.map((f) => f.k));
  const doc = {};
  const unknown = [];
  for (const [k, v] of Object.entries(pairs)) {
    if (allowed.has(k)) doc[k] = v;
    else unknown.push(k);
  }
  return { doc, unknown };
}

/** Free text for `add`: "250 groceries" fills amount + the main field. */
function addFromFreeText(collection, words) {
  const doc = {};
  let rest = words.slice();
  const moneyKey = MONEY_FIELD[collection];
  if (moneyKey && rest.length) {
    const m = rest[0].match(/^₹?([\d,]+(?:\.\d{1,2})?)$/);
    if (m) {
      doc[moneyKey] = m[1].replace(/,/g, '');
      rest = rest.slice(1);
    }
  }
  if (!doc[moneyKey] && rest.length) {
    const last = rest[rest.length - 1].match(/^₹?([\d,]+(?:\.\d{1,2})?)$/);
    if (last) {
      doc[moneyKey] = last[1].replace(/,/g, '');
      rest = rest.slice(0, -1);
    }
  }
  if (rest.length) doc[MAIN_FIELD[collection]] = rest.join(' ');
  return doc;
}

export async function handleMessage(env, phone, text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const link = await whatsappLink(env, phone);

  const linkMatch = raw.match(/^link\s+([A-Za-z0-9-]{4,20})$/i);
  if (linkMatch) return linkReply(env, phone, linkMatch[1]);

  if (!link) {
    return 'This number is not linked to a planner.\nOpen the app → Settings → WhatsApp → Create link code, then text me *link CODE*.';
  }

  const words = raw.split(/\s+/);
  const verb = words[0].toLowerCase().replace(/[.!?]+$/, '');
  const rest = words.slice(1);
  const { profile, rows } = await resolveChat(env, link);

  if (verb === 'help' || verb === 'hi' || verb === 'hello' || verb === 'hey' || verb === 'start') return HELP;

  if (verb === 'profile' || verb === 'whoami') {
    return `Writing to *${profile.name}* (${profile.role}).\nOther books: ${rows
      .map((r) => r.name)
      .join(', ')}\nSwitch with "use <name>".`;
  }

  if (verb === 'use') {
    const wanted = rest.join(' ').toLowerCase();
    const match = rows.find((r) => r.name.toLowerCase() === wanted) || rows.find((r) => r.id === wanted);
    if (!match) return `I could not find "${rest.join(' ')}". Books: ${rows.map((r) => r.name).join(', ')}.`;
    await setWhatsappProfile(env, phone, match.id);
    return `Now writing to *${match.name}*.`;
  }

  if (verb === 'unlink') {
    await unlinkWhatsapp(env, phone);
    return 'Unlinked. This number can no longer read or change the planner.';
  }

  if (verb === 'summary' || verb === 'balance' || verb === 'status') return summary(env, link, profile);

  if (verb === 'list' || verb === 'show') {
    const name = collectionOf(rest[0]);
    if (!name) return `Which list? ${Object.keys(COLLECTIONS).join(', ')}.`;
    const limit = Math.min(Number(rest[1]) || 10, 20);
    return listReply(env, link, profile, name, limit);
  }

  if (verb === 'add' || verb === 'new' || verb === 'create') {
    const name = collectionOf(rest[0]);
    if (!name) return 'What should I add? Try "add expense 250 groceries" or "add task Call plumber".';
    const { pairs, words: free } = parsePairs(rest.slice(1));
    const { doc: explicit, unknown } = fieldsOnly(name, pairs);
    const doc = { ...addFromFreeText(name, free), ...explicit };
    const dateKey = DATE_FIELD[name];
    if (dateKey && !doc[dateKey]) doc[dateKey] = isoToday();
    if (doc[dateKey]) doc[dateKey] = readDate(doc[dateKey], isoToday());
    if (!doc.status && OPEN_STATUS[name] && (name === 'expenses' || name === 'payments')) doc.status = 'Unpaid';
    if (!doc.status && name === 'diary') doc.status = 'Pending';
    if (name === 'expenses' && !doc.status) doc.status = 'Paid';
    const space = await resolveProfile(env, sessionFor(link, profile), profile.id, 'create');
    const out = await createRecord(env, space.id, name, doc, link.user_id);
    const note = unknown.length ? `\n(I ignored ${unknown.join(', ')} — not a field here.)` : '';
    return `Added to ${COLLECTIONS[name].label.toLowerCase()}:\n${rowLine(1, name, out.record)}${note}`;
  }

  if (verb === 'done' || verb === 'close' || verb === 'paid') {
    const name = rest[1] ? collectionOf(rest[0]) : 'diary';
    const ref = rest[1] || rest[0];
    if (!name) return 'Which list is that in? Try "done tasks 2" or "done bills 1".';
    const id = await target(env, phone, name, ref);
    if (!id) return `I do not have a ${COLLECTIONS[name].label.toLowerCase()} row ${ref}. Send "list ${name}" first.`;
    const space = await resolveProfile(env, sessionFor(link, profile), profile.id, 'update');
    const out = await updateRecord(env, space.id, name, id, { status: OPEN_STATUS[name] || 'Done' }, link.user_id);
    return `Marked ${OPEN_STATUS[name] || 'Done'}: ${rowLine(1, name, out.record)}`;
  }

  if (verb === 'edit' || verb === 'set' || verb === 'update') {
    const name = collectionOf(rest[0]);
    const ref = rest[1];
    if (!name || !ref) return 'Format: edit bills 2 amount=1300 status=Paid';
    const { pairs } = parsePairs(rest.slice(2));
    const { doc, unknown } = fieldsOnly(name, pairs);
    if (!Object.keys(doc).length) return `Give me at least one field, e.g. edit ${name} ${ref} amount=500.${unknown.length ? ` (${unknown.join(', ')} are not fields)` : ''}`;
    if (doc[DATE_FIELD[name]]) doc[DATE_FIELD[name]] = readDate(doc[DATE_FIELD[name]], isoToday());
    const id = await target(env, phone, name, ref);
    if (!id) return `I do not have a ${COLLECTIONS[name].label.toLowerCase()} row ${ref}. Send "list ${name}" first.`;
    const space = await resolveProfile(env, sessionFor(link, profile), profile.id, 'update');
    const out = await updateRecord(env, space.id, name, id, doc, link.user_id);
    return `Updated: ${rowLine(1, name, out.record)}`;
  }

  if (verb === 'delete' || verb === 'remove' || verb === 'del') {
    const name = collectionOf(rest[0]);
    const ref = rest[1];
    if (!name || !ref) return 'Format: delete tasks 4';
    const id = await target(env, phone, name, ref);
    if (!id) return `I do not have a ${COLLECTIONS[name].label.toLowerCase()} row ${ref}.`;
    const space = await resolveProfile(env, sessionFor(link, profile), profile.id, 'delete');
    await deleteRecord(env, space.id, name, id, link.user_id);
    return `Deleted ${COLLECTIONS[name].label.toLowerCase()} row ${ref}.`;
  }

  // A bare collection word is a list request: "expenses", "bills", "tasks".
  if (collectionOf(verb)) return listReply(env, link, profile, collectionOf(verb), 10);

  return `I did not understand "${raw.slice(0, 60)}".\nSend *help* for the command list.`;
}
