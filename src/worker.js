// Family Finance Planner API + static host.
// Plain module Worker: no framework, no runtime dependencies.

import { COLLECTIONS, COLLECTION_NAMES, sanitizeDoc } from '../web/src/entities.js';
import {
  HttpError,
  activeAiConnection,
  checkInvite,
  createInvite,
  emailTaken,
  listMembers,
  memberRole,
  redeemInvite,
  removeMember,
  addAiConnection,
  activityFeed,
  credentialsFor,
  createEmailUser,
  deleteAiConnection,
  deleteFileRow,
  getFile,
  insertFile,
  isEmail,
  isStrongPassword,
  listAiConnections,
  listFiles,
  normaliseEmail,
  setPassword,
  verifyPassword,
  bulkCreate,
  clearAuthFailures,
  clientIp,
  countUnread,
  countUsers,
  createRecord,
  createSession,
  createUser,
  deleteRecord,
  deleteSession,
  deleteUserSessions,
  ensureSchema,
  getMeta,
  getSession,
  getState,
  isLockedOut,
  listCollection,
  listNotifications,
  listSessions,
  markRead,
  pruneChanges,
  recordAuthFailure,
  seedDatabase,
  setMeta,
  sweep,
  updatePin,
  updateRecord,
  verifyPin,
  wipeRecords,
} from './store.js';
import { removeSubscription, saveSubscription, sendTestPush } from './push.js';
import { scanReceipt, testConnection } from './ai.js';
import { encryptionReady } from './fieldcrypto.js';
import { ICONS } from './icons.js';

/** Content sniffing: the browser-declared type is never trusted. */
function sniffMime(head) {
  const b = head;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return '';
}

const COOKIE = 'ffp_session';
const PIN_RE = /^\d{4,12}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // Icons are inlined in the Worker: static hosting here only accepts
      // text/JS/JSON assets, and the PWA manifest needs real PNGs.
      const iconName = url.pathname.replace(/^\//, '');
      if (ICONS[iconName]) return iconResponse(ICONS[iconName]);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, url);
      }
      return await serveStatic(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      const message = err && err.message ? err.message : String(err);
      const missingDb = /no such table|D1_ERROR|binding/i.test(message);
      return json(
        {
          error: missingDb
            ? 'Database is not initialised yet. Deploy the Worker with a D1 binding named DB, then reload.'
            : 'Unexpected server error',
          detail: message.slice(0, 300),
        },
        500,
      );
    }
  },
};

/* ------------------------------------------------------------- responses */

function securityHeaders(res) {
  const headers = new Headers(res.headers);
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function iconResponse(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return securityHeaders(
    new Response(bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800, immutable',
      },
    }),
  );
}

function json(data, status = 200, headers = {}) {
  return securityHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
      },
    }),
  );
}

/* ---------------------------------------------------------------- static */

async function serveStatic(request, env, url) {
  if (!env.ASSETS) return json({ error: 'Static assets are not configured' }, 500);
  let res = await env.ASSETS.fetch(request);
  // Only real page navigations fall back to the shell: a missing asset must stay a
  // 404 so a stale bundle cannot be answered with HTML (which breaks MIME checks).
  const accept = request.headers.get('Accept') || '';
  const isNavigation = request.mode === 'navigate' || accept.includes('text/html');
  const looksLikeAsset = /\.[a-z0-9]+$/i.test(url.pathname);
  if (res.status === 404 && request.method === 'GET' && isNavigation && !looksLikeAsset) {
    const fallback = new URL('/index.html', url);
    res = await env.ASSETS.fetch(new Request(fallback.toString(), { method: 'GET', headers: request.headers }));
    res = new Response(res.body, { status: 200, headers: res.headers });
  }
  const out = securityHeaders(res);
  const path = url.pathname;
  if (path.startsWith('/assets/')) {
    // Vite fingerprints these filenames, so they can be cached for a year.
    out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (path === '/sw.js' || path.endsWith('manifest.json') || path === '/' || path === '/index.html') {
    out.headers.set('Cache-Control', 'no-cache');
  }
  if (path === '/sw.js') out.headers.set('Service-Worker-Allowed', '/');
  return out;
}

/* ------------------------------------------------------------------ auth */

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

function sessionCookie(token, url, maxAge = 30 * 86400) {
  const secure = url.protocol === 'https:' || url.hostname !== 'localhost' ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(url) {
  const secure = url.protocol === 'https:' || url.hostname !== 'localhost' ? '; Secure' : '';
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function spaceFor(raw, session) {
  const value = String(raw || '').toLowerCase();
  if (value === 'personal') return `u:${session.userId}`;
  if (value === 'office') return `o:${session.userId}`;
  return 'family';
}

function requestSpace(request, session) {
  return spaceFor(request.headers.get('X-Space'), session);
}

async function requireUser(request, env, url) {
  if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
  const token = readCookie(request, COOKIE);
  const session = await getSession(env, token);
  if (!session) throw new HttpError(401, 'Sign in required');
  return { session, token };
}

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Expected application/json');
  const text = await request.text();
  if (text.length > 4_000_000) throw new HttpError(413, 'Body too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/* ------------------------------------------------------------------- api */

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health') {
    return json({ ok: true, database: Boolean(env.DB), assets: Boolean(env.ASSETS), time: Date.now() });
  }
  if (!env.DB) return json({ error: 'Database binding DB is missing' }, 503);

  await ensureSchema(env);

  if (path === '/api/auth/status' && method === 'GET') {
    const configured = (await countUsers(env)) > 0;
    const session = configured ? await getSession(env, readCookie(request, COOKIE)) : null;
    return json({
      configured,
      user: session ? { name: session.name } : null,
      push: Boolean((await getMeta(env, 'vapid', null))?.publicKey),
      signupOpen: configured,
    });
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    if ((await countUsers(env)) === 0) throw new HttpError(403, 'Set up the planner first');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const body = await readJson(request);
    const email = normaliseEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
    if (!isStrongPassword(body.password)) throw new HttpError(400, 'Password needs at least 8 characters with a letter and a number');
    if (await emailTaken(env, email)) throw new HttpError(409, 'That email already has an account');
    const invite = await checkInvite(env, body.code);
    if (!invite) throw new HttpError(403, 'An invite code from the household owner is required');
    let user;
    try {
      user = await createEmailUser(env, email, String(body.password), body.name);
    } catch (err) {
      await recordAuthFailure(env, ip);
      throw err;
    }
    await redeemInvite(env, invite.code, user.id);
    const token = await createSession(env, user.id, request);
    return json({ ok: true, user: { name: user.name, email: user.email } }, 200, { 'Set-Cookie': sessionCookie(token, url) });
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    if ((await countUsers(env)) > 0) throw new HttpError(403, 'This planner is already set up');
    const body = await readJson(request);
    if (!PIN_RE.test(String(body.pin || ''))) throw new HttpError(400, 'PIN must be 4-12 digits');
    const user = await createUser(env, body.name, String(body.pin));
    await seedDatabase(env, user.id);
    const token = await createSession(env, user.id, request);
    return json({ ok: true, user: { name: user.name } }, 200, {
      'Set-Cookie': sessionCookie(token, url),
    });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) {
      throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    }
    const body = await readJson(request);
    let user = null;
    if (body.email) {
      user = await verifyPassword(env, body.email, String(body.password || ''));
      if (!user) {
        await recordAuthFailure(env, ip);
        throw new HttpError(401, 'Email or password is incorrect');
      }
    } else {
      const pin = String(body.pin || '');
      if (!PIN_RE.test(pin)) {
        await recordAuthFailure(env, ip);
        throw new HttpError(401, 'Incorrect PIN');
      }
      user = await verifyPin(env, pin);
      if (!user) {
        await recordAuthFailure(env, ip);
        throw new HttpError(401, 'Incorrect PIN');
      }
    }
    await clearAuthFailures(env, ip);
    const token = await createSession(env, user.id, request);
    return json({ ok: true, user }, 200, { 'Set-Cookie': sessionCookie(token, url) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    await deleteSession(env, readCookie(request, COOKIE));
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(url) });
  }

  if (path === '/api/auth/lock' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    await deleteSession(env, readCookie(request, COOKIE));
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(url) });
  }

  const { session, token } = await requireUser(request, env, url);
  const space = requestSpace(request, session);

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readJson(request);
    const email = normaliseEmail(body.email || (await credentialsFor(env, session.userId))?.email || '');
    if (!isEmail(email)) throw new HttpError(400, 'Enter the email to sign in with');
    if (!isStrongPassword(body.next)) throw new HttpError(400, 'Password needs at least 8 characters with a letter and a number');
    const current = String(body.current || '');
    const byPassword = email ? await verifyPassword(env, email, current) : null;
    const byPin = byPassword ? null : await verifyPin(env, current);
    if (!byPassword && !byPin) throw new HttpError(401, 'Current password is incorrect');
    await setPassword(env, session.userId, email, String(body.next));
    await deleteUserSessions(env, session.userId, session.sessionId);
    return json({ ok: true, email });
  }

  if (path === '/api/auth/account' && method === 'GET') {
    const creds = await credentialsFor(env, session.userId);
    return json({
      name: session.name,
      email: creds ? creds.email : null,
      role: (await memberRole(env, session.userId)) || (creds ? 'member' : 'owner'),
      encryption: await encryptionReady(env),
      spaces: ['family', 'personal', 'office'],
      storage: Boolean(env.FILES),
      ai: Boolean(await activeAiConnection(env)),
    });
  }

  if (path === '/api/auth/pin' && method === 'POST') {
    const body = await readJson(request);
    if (!PIN_RE.test(String(body.newPin || ''))) throw new HttpError(400, 'PIN must be 4-12 digits');
    const ok = await verifyPin(env, String(body.currentPin || ''));
    if (!ok) throw new HttpError(401, 'Current PIN is incorrect');
    await updatePin(env, String(body.newPin));
    await deleteUserSessions(env, session.userId, session.sessionId);
    return json({ ok: true });
  }

  if (path === '/api/auth/sessions' && method === 'GET') {
    return json({ sessions: await listSessions(env, session.userId), current: session.sessionId });
  }

  if (path === '/api/auth/sessions/revoke' && method === 'POST') {
    await deleteUserSessions(env, session.userId, null);
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(url) });
  }

  if (path === '/api/state' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    ctx.waitUntil(runBackground(env));
    const state = await getState(env, Number.isFinite(since) ? since : 0, space);
    return json({ ...state, me: { name: session.name }, spaces: ['family', 'personal'] });
  }

  if (path === '/api/activity' && method === 'GET') {
    return json({ activity: await activityFeed(env, space, 30) });
  }

  if (path === '/api/notifications' && method === 'GET') {
    return json({ notifications: await listNotifications(env, space, 60), unread: await countUnread(env, space) });
  }

  if (path === '/api/notifications/read' && method === 'POST') {
    const body = await readJson(request);
    await markRead(env, space, Array.isArray(body.ids) ? body.ids : null);
    return json({ ok: true, unread: await countUnread(env, space) });
  }

  if (path === '/api/push/key' && method === 'GET') {
    const keys = await getMeta(env, 'vapid', null);
    return json({ publicKey: keys ? keys.publicKey : null });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const body = await readJson(request);
    const saved = await saveSubscription(env, body, request.headers.get('User-Agent'));
    if (!saved) throw new HttpError(400, 'Invalid push subscription');
    return json({ ok: true });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readJson(request);
    await removeSubscription(env, body.endpoint);
    return json({ ok: true });
  }

  if (path === '/api/push/test' && method === 'POST') {
    return json(await sendTestPush(env));
  }

  if (path === '/api/settings' && method === 'POST') {
    const body = await readJson(request);
    const clean = {
      mobile: String(body.mobile || '').slice(0, 40),
      alertTime: /^\d{2}:\d{2}$/.test(String(body.alertTime || '')) ? body.alertTime : '06:00',
      channel: String(body.channel || '').slice(0, 80),
      currency: 'INR',
      household: String(body.household || '').slice(0, 80),
    };
    await setMeta(env, 'settings', clean);
    return json({ ok: true, settings: clean });
  }

  if (path === '/api/records' && method === 'POST') {
    const body = await readJson(request);
    const out = await createRecord(env, space, String(body.collection || ''), body.doc || {}, session.userId);
    ctx.waitUntil(runBackground(env));
    return json(out);
  }

  if (path === '/api/records/bulk' && method === 'POST') {
    const body = await readJson(request);
    const collection = String(body.collection || '');
    if (!COLLECTIONS[collection]) throw new HttpError(400, 'Unknown collection');
    const dedupeKey =
      collection === 'contacts'
        ? (doc) => {
            const digits = String(doc.mobile || '').replace(/\D/g, '');
            return digits.length >= 10 ? digits.slice(-10) : '';
          }
        : null;
    const stats = await bulkCreate(env, space, collection, body.docs || [], session.userId, dedupeKey);
    ctx.waitUntil(runBackground(env));
    return json(stats);
  }

  const recordMatch = path.match(/^\/api\/records\/([a-zA-Z]+)\/([A-Za-z0-9_-]{1,64})$/);
  if (recordMatch) {
    const collection = recordMatch[1];
    const id = recordMatch[2];
    if (method === 'PATCH') {
      const body = await readJson(request);
      const out = await updateRecord(env, space, collection, id, body.doc || {}, session.userId);
      ctx.waitUntil(runBackground(env));
      return json(out);
    }
    if (method === 'DELETE') {
      const out = await deleteRecord(env, space, collection, id, session.userId);
      ctx.waitUntil(runBackground(env));
      return json(out);
    }
  }

  if (path === '/api/export' && method === 'GET') {
    const out = { exportedAt: new Date().toISOString(), settings: await getMeta(env, 'settings', null), data: {} };
    for (const name of COLLECTION_NAMES) out.data[name] = await listCollection(env, space, name);
    return json(out, 200, {
      'Content-Disposition': `attachment; filename="family-finance-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  /* ------------------------------------------------------------ drive */

  if (path === '/api/files' && method === 'GET') {
    return json({ ...(await listFiles(env, space, 60)), storage: Boolean(env.FILES) });
  }

  if (path === '/api/files' && method === 'POST') {
    if (!env.FILES) throw new HttpError(503, 'File storage is not configured for this site');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Attach a file');
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) throw new HttpError(400, 'The file is empty');
    if (bytes.byteLength > 8 * 1024 * 1024) throw new HttpError(413, 'Files must be 8 MB or smaller');
    const mime = sniffMime(new Uint8Array(bytes).slice(0, 16));
    if (!mime) throw new HttpError(415, 'Only JPEG, PNG, WebP images and PDF files are accepted');
    const id = crypto.randomUUID();
    const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg');
    const key = `drive/${id}.${ext}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
    await insertFile(env, {
      id,
      space,
      key,
      name: String(file.name || `document.${ext}`).slice(0, 120),
      mime,
      size: bytes.byteLength,
      collection: String(form.get('collection') || '').slice(0, 40) || null,
      recordId: String(form.get('recordId') || '').slice(0, 64) || null,
      uploadedBy: session.userId,
    });
    return json({ ok: true, file: { id, name: String(file.name || '').slice(0, 120), mime, size: bytes.byteLength } });
  }

  const fileMatch = path.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (fileMatch) {
    const meta = await getFile(env, fileMatch[1]);
    if (!meta || meta.space !== space) throw new HttpError(404, 'File not found');
    if (method === 'GET') {
      if (!env.FILES) throw new HttpError(503, 'File storage is not configured');
      const object = await env.FILES.get(meta.key);
      if (!object) throw new HttpError(404, 'File contents are gone');
      return new Response(object.body, {
        headers: {
          'Content-Type': meta.mime,
          'Content-Length': String(meta.size),
          'Cache-Control': 'private, max-age=300',
          'Content-Disposition': `${meta.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${String(meta.name).replace(/[^\w.\- ]/g, '_')}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (method === 'DELETE') {
      if (env.FILES) await env.FILES.delete(meta.key);
      await deleteFileRow(env, meta.id);
      return json({ ok: true });
    }
  }

  if (path === '/api/scan' && method === 'POST') {
    if (!env.FILES) throw new HttpError(503, 'File storage is not configured for this site');
    const body = await readJson(request);
    const meta = await getFile(env, String(body.fileId || ''));
    if (!meta || meta.space !== space) throw new HttpError(404, 'Upload the bill first');
    const object = await env.FILES.get(meta.key);
    if (!object) throw new HttpError(404, 'File contents are gone');
    const bytes = await object.arrayBuffer();
    const result = await scanReceipt(env, bytes, meta.mime);
    return json({ ...result, fileId: meta.id });
  }

  /* --------------------------------------------------------- AI tools */

  if (path === '/api/ai/connections' && method === 'GET') {
    const rows = await listAiConnections(env);
    return json({ connections: rows.map((r) => ({ ...r, apiKey: undefined, masked: '••••' })) });
  }

  if (path === '/api/ai/connections' && method === 'POST') {
    const body = await readJson(request);
    const created = await addAiConnection(env, body, session.userId);
    return json({ ok: true, connection: created });
  }

  const aiMatch = path.match(/^\/api\/ai\/connections\/([0-9a-f-]{36})(\/test)?$/);
  if (aiMatch) {
    if (method === 'DELETE' && !aiMatch[2]) {
      await deleteAiConnection(env, aiMatch[1]);
      return json({ ok: true });
    }
    if (method === 'POST' && aiMatch[2]) {
      const connection = await activeAiConnection(env);
      if (!connection || connection.id !== aiMatch[1]) throw new HttpError(404, 'Connection not found');
      return json(await testConnection(connection));
    }
  }

  /* ------------------------------------------------------------ family */

  if (path === '/api/family/members' && method === 'GET') {
    return json({
      members: await listMembers(env),
      me: session.userId,
      role: await memberRole(env, session.userId),
    });
  }

  if (path === '/api/family/invite' && method === 'POST') {
    if ((await memberRole(env, session.userId)) !== 'owner') {
      throw new HttpError(403, 'Only the household owner can invite members');
    }
    return json({ ok: true, ...(await createInvite(env, session.userId)) });
  }

  const memberMatch = path.match(/^\/api\/family\/members\/([0-9a-f-]{36})$/);
  if (memberMatch && method === 'DELETE') {
    if ((await memberRole(env, session.userId)) !== 'owner') {
      throw new HttpError(403, 'Only the household owner can remove members');
    }
    if (memberMatch[1] === session.userId) throw new HttpError(400, 'You cannot remove your own account');
    await removeMember(env, memberMatch[1]);
    return json({ ok: true });
  }

  if (path === '/api/admin/reset' && method === 'POST') {
    await wipeRecords(env);
    await seedDatabase(env, session.userId);
    return json({ ok: true });
  }

  if (path === '/api/admin/clear' && method === 'POST') {
    await wipeRecords(env);
    return json({ ok: true });
  }

  if (path === '/api/admin/sample' && method === 'POST') {
    await wipeRecords(env);
    await seedDatabase(env, session.userId);
    return json({ ok: true });
  }

  if (path === '/api/events' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    return streamEvents(env, since, spaceFor(url.searchParams.get('space'), session));
  }

  throw new HttpError(404, 'Not found');
}

async function runBackground(env) {
  try {
    await sweep(env);
    await pruneChanges(env);
  } catch {
    /* background maintenance must never break a request */
  }
}

/* ------------------------------------------------------------------- sse */

function streamEvents(env, since, space = 'family') {
  const encoder = new TextEncoder();
  let stopped = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk) => {
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stopped = true;
        }
      };
      const finish = () => {
        if (stopped) return;
        stopped = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send('retry: 3000\n\n');
      send(': connected\n\n');
      const deadline = Date.now() + 50000;

      const tick = async () => {
        if (stopped) return;
        try {
          const row = await env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS rev FROM changes WHERE space = ?`)
            .bind(space)
            .first();
          const rev = row ? row.rev : 0;
          if (rev > since) {
            send(`event: change\ndata: ${JSON.stringify({ rev })}\n\n`);
            finish();
            return;
          }
          send(': ping\n\n');
        } catch {
          finish();
          return;
        }
        if (Date.now() > deadline) {
          send('event: idle\ndata: {}\n\n');
          finish();
          return;
        }
        setTimeout(tick, 2500);
      };

      setTimeout(tick, 600);
    },
    cancel() {
      stopped = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

export { sanitizeDoc };
