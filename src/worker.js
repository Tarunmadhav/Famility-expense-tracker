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
  listNotificationsAcross,
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
  hitRateLimit,
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
  updateAccountName,
  updatePin,
  updateRecord,
  verifyPin,
  verifyUserPin,
  wipeRecords,
  accountHasTotp,
  beginTotp,
  consumeEmailOtp,
  createEmailOtp,
  createRecoveryCode,
  disableTotp,
  resolveOauthAccount,
  getUser,
  randomToken,
  enableTotp,
  recoverWithCode,
  totpState,
  verifyTotp,
} from './store.js';
import { removeSubscription, saveSubscription, sendTestPush } from './push.js';
import { scanReceipt, testConnection } from './ai.js';
import { encryptionReady } from './fieldcrypto.js';
import { downloadBackup, finishConnect, listBackups, providerInfo, startConnect } from './cloud.js';
import { backupKeyConfigured } from './backupcrypto.js';
import { CLOUD_PROVIDER_IDS, cloudLink, restoreExport, runBackup, runScheduledBackups } from './backup.js';
import { calendarFeed, calendarToken } from './calendarfeed.js';
import { emailConfigured, sendOtpEmail } from './email.js';
import {
  consumeLoginTicket,
  exchangeCode,
  fetchIdentity,
  issueLoginTicket,
  providerOf,
  signInProviders,
  startAuthorization,
} from './oauth.js';
import {
  assertTelegramConfigured,
  createLinkCode,
  deliverPending,
  handleUpdate,
  linkForUser,
  sendMessage,
  setPreview,
  telegramConfigured,
  telegramMissing,
  telegramWebhookConfigured,
  unlinkTelegram,
  webhookSecretOk,
} from './telegram.js';
import { ICONS } from './icons.js';
import {
  ROLE_LABEL,
  audit,
  isRole,
  listAudit,
  listProfiles,
  profileMembers,
  resolveProfile,
  setMemberRole,
} from './profiles.js';

/** Build/api version reported to clients; bump when the API contract changes. */
const APP_VERSION = '2.4.2';
const API_VERSION = 14;

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

/**
 * Tables carried over when the household moves to another Cloudflare account.
 * `sessions` is deliberately absent: session tokens are bound to this origin's cookie
 * and cannot be reused elsewhere. `auth_fails` and `rate_limits` are transient abuse
 * counters that must not lock the owner out of the new deployment.
 * See migration/DATABASE_MIGRATION.md. This route is temporary: remove it after the move.
 */
const SNAPSHOT_TABLES = [
  'meta',
  'users',
  'credentials',
  'records',
  'changes',
  'notifications',
  'push_subs',
  'files',
  'ai_connections',
  'family_invites',
  'profiles',
  'profile_members',
  'audit_log',
];
const SNAPSHOT_PAGE = 500;

export default {
  /** Cron Trigger: only accounts with automatic backup on are touched. */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const now = event && event.scheduledTime ? event.scheduledTime : Date.now();
    ctx.waitUntil(
      runScheduledBackups(env, { now }).catch((err) =>
        console.error('scheduled backup run failed', err && err.message),
      ),
    );
    // A queued alert that failed while the isolate was busy gets another chance
    // here, without a request having to happen first.
    ctx.waitUntil(
      deliverPending(env, { now }).catch((err) => console.error('telegram drain failed', err && err.message)),
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // workers.dev terminates TLS, but a custom domain or a proxy in front could
    // still forward plain HTTP. Never serve a session over a cleartext origin.
    if (url.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(url.hostname)) {
      const secure = new URL(url.toString());
      secure.protocol = 'https:';
      return securityHeaders(Response.redirect(secure.toString(), 308));
    }
    try {
      // Icons are inlined in the Worker: static hosting here only accepts
      // text/JS/JSON assets, and the PWA manifest needs real PNGs.
      const iconName = url.pathname.replace(/^\//, '');
      if (ICONS[iconName]) return iconResponse(ICONS[iconName]);
      // Android App Links verification for the OAuth return leg. The fingerprint
      // is a public fact about the signing certificate, kept in a Worker variable
      // so rotating the key does not need a code change. Without it the link still
      // works; the platform only shows a chooser first.
      if (url.pathname === '/.well-known/assetlinks.json') {
        const fingerprints = String(env.ANDROID_SHA256 || '')
          .split(',')
          .map((f) => f.trim().toUpperCase())
          .filter(Boolean);
        if (!fingerprints.length) return json({ error: 'Android App Links are not configured' }, 404);
        return json(
          [
            {
              relation: ['delegate_permission/common.handle_all_urls'],
              target: {
                namespace: 'android_app',
                package_name: 'com.family.planner',
                sha256_cert_fingerprints: fingerprints,
              },
            },
          ],
          200,
          { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/json' },
        );
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, url);
      }
      return await serveStatic(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      const message = err && err.message ? err.message : String(err);
      // A constraint violation is a bug in the calling route, not an uninitialised
      // database: matching the bare D1_ERROR prefix used to label every failed D1
      // write the same way and hide the real cause.
      const constraint = /UNIQUE constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed/i.test(message);
      const missingDb = !constraint && /no such table|no such column|no such index|binding/i.test(message);
      // Diagnostics stay in the Worker log. The response carries no SQL text,
      // stack frame, binding name or column detail.
      console.error('unhandled', pathOf(request), message.slice(0, 500));
      return json(
        {
          error: missingDb
            ? 'Database is not initialised yet. Deploy the Worker with a D1 binding named DB, then reload.'
            : 'Unexpected server error',
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
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
  } else if (path === '/' || path === '/index.html') {
    // The shell names the hashed CSS and JS of exactly one build. If a cached copy
    // survives a deploy, those hashes 404 and the app renders with no styles at all,
    // which is what a phone with a stale index.html was showing. Never store it:
    // both the WebView's HTTP cache and the service worker are kept out of the loop.
    out.headers.set('Cache-Control', 'no-store, must-revalidate');
    out.headers.set('Pragma', 'no-cache');
  } else if (path === '/sw.js' || path.endsWith('manifest.json')) {
    out.headers.set('Cache-Control', 'no-cache');
  }
  if (path.startsWith('/download/') && path.endsWith('.apk')) {
    // The APK is a real installable artifact, not something a browser should try
    // to render, and it must stay fresh enough that a new release downloads.
    out.headers.set('Content-Type', 'application/vnd.android.package-archive');
    out.headers.set('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`);
    out.headers.set('Cache-Control', 'public, max-age=300');
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

/** Length-independent compare for the webhook's shared verification token. */
function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length === right.length ? 0 : 1;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) diff |= left.charCodeAt(i % (left.length || 1)) ^ (right.charCodeAt(i % (right.length || 1)) || 0);
  return diff === 0;
}

function spaceFor(raw, session) {
  const value = String(raw || '').toLowerCase();
  if (value === 'personal') return `u:${session.userId}`;
  if (value === 'office') return `o:${session.userId}`;
  // Each household keeps its own shared book; 'family' is the original one.
  return session.household || `h:${session.userId}`;
}

/**
 * The profile this request targets. `X-Profile` names a profile id directly;
 * `X-Space` keeps the original family/personal/office vocabulary working.
 */
function requestSpace(request, session) {
  const explicit = String(request.headers.get('X-Profile') || '').trim();
  if (explicit) return explicit.slice(0, 80);
  // EventSource cannot set headers, so the live stream names its profile in the
  // query string. It is still validated against membership below.
  try {
    const fromQuery = String(new URL(request.url).searchParams.get('profile') || '').trim();
    if (fromQuery) return fromQuery.slice(0, 80);
  } catch {
    /* malformed url: fall through to the header vocabulary */
  }
  return spaceFor(request.headers.get('X-Space'), session);
}

/**
 * Which permission a route needs. Returning null means "not profile scoped":
 * account and device routes are handled without touching a profile at all.
 * The mapping is the single place that decides authorisation, so a new route
 * cannot accidentally ship without a check.
 */
function permissionFor(method, path) {
  if (path.startsWith('/api/auth/')) return null;
  if (path.startsWith('/api/push/')) return null;
  if (path === '/api/version') return null;
  if (path === '/api/notifications/all') return null;
  if (path.startsWith('/api/profiles')) return null;
  if (path.startsWith('/api/cloud')) return null;
  if (path.startsWith('/api/telegram')) return null;
  // The .ics feed authenticates by its token, and the two management routes are
  // ordinary session routes below.
  if (/^\/api\/calendar\/[0-9a-f]{48}\.ics$/.test(path)) return null;
  if (path === '/api/calendar/feed') return method === 'GET' ? 'view' : 'manage';
  if (path === '/api/health') return null;
  if (path === '/api/notifications/read') return 'view';
  if (path.startsWith('/api/admin/')) return 'manage';
  if (path === '/api/family/members' && method === 'GET') return 'view';
  if (path.startsWith('/api/family/')) return 'manage';
  if (path.startsWith('/api/ai/')) return method === 'GET' ? 'view' : 'manage';
  if (path === '/api/settings') return 'manage';
  if (path === '/api/export') return 'export';
  if (path === '/api/audit') return 'manage';
  if (path === '/api/backup') return 'export';
  if (method === 'GET' || method === 'HEAD') return 'view';
  if (method === 'DELETE') return 'delete';
  if (method === 'PATCH') return 'update';
  if (method === 'POST') return 'create';
  return 'view';
}

/** The office book only holds work modules; anything else is rejected at the API. */
const OFFICE_COLLECTIONS = new Set(['diary', 'contacts', 'expenses']);

function assertSpaceCollection(space, collection) {
  if (String(space).startsWith('o:') && !OFFICE_COLLECTIONS.has(String(collection))) {
    throw new HttpError(400, 'That module is not available in the office book');
  }
}

const WRITE_LIMIT = 120;
const WRITE_WINDOW_MS = 60_000;

async function enforceWriteLimit(env, userId) {
  if (await hitRateLimit(env, `w:${userId}`, WRITE_LIMIT, WRITE_WINDOW_MS)) {
    throw new HttpError(429, 'Too many changes in a minute. Wait a moment and try again.');
  }
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
    return json({
      ok: true,
      database: Boolean(env.DB),
      assets: Boolean(env.ASSETS),
      storage: Boolean(env.FILES),
      version: APP_VERSION,
      api: API_VERSION,
      time: Date.now(),
    });
  }
  if (!env.DB) return json({ error: 'Database binding DB is missing' }, 503);

  await ensureSchema(env);

  // Public: the web/Android shell compares this with what it is running to show
  // an update notice without ever blocking the app on a bad release field.
  if (path === '/api/version' && method === 'GET') {
    const release = (await getMeta(env, 'release', null)) || {};
    return json({
      app: 'family-finance-planner',
      version: String(release.version || APP_VERSION),
      api: API_VERSION,
      minimum: String(release.minimum || ''),
      notes: String(release.notes || '').slice(0, 500),
      apkUrl: release.apkUrl ? String(release.apkUrl).slice(0, 300) : null,
      apkSha256: release.apkSha256 ? String(release.apkSha256).slice(0, 80) : null,
      publishedAt: release.publishedAt || null,
      serverTime: Date.now(),
    });
  }

  if (path === '/api/auth/status' && method === 'GET') {
    const configured = (await countUsers(env)) > 0;
    const session = configured ? await getSession(env, readCookie(request, COOKIE)) : null;
    return json({
      configured,
      user: session ? { name: session.name } : null,
      push: Boolean((await getMeta(env, 'vapid', null))?.publicKey),
      signupOpen: true,
      email: emailConfigured(env),
      providers: signInProviders(env),
    });
  }

  if (path === '/api/auth/otp/request' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (await hitRateLimit(env, `otp:${ip}`, 6, 3600_000)) {
      throw new HttpError(429, 'Too many codes requested. Try again in an hour.');
    }
    // Checked before the lookup, and for every address: answering 501 only when
    // the account exists would turn this form into an account-existence oracle.
    if (!emailConfigured(env)) {
      throw new HttpError(
        501,
        'Email is not configured. Add RESEND_API_KEY (and optionally MAIL_FROM) as Worker secrets to enable email codes.',
      );
    }
    const body = await readJson(request);
    const email = normaliseEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
    const known = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`).bind(email).first();
    // The reply is the same either way, so the form cannot be used to discover
    // which addresses have accounts.
    if (known) {
      const { code, minutes } = await createEmailOtp(env, email);
      await sendOtpEmail(env, { to: email, code, minutes });
      await audit(env, { action: 'auth.otp', actor: known.user_id });
    }
    return json({ ok: true, emailed: true });
  }

  if (path === '/api/auth/otp/reset' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (!emailConfigured(env)) {
      throw new HttpError(
        501,
        'Email is not configured. Add RESEND_API_KEY (and optionally MAIL_FROM) as Worker secrets to enable email codes.',
      );
    }
    const body = await readJson(request);
    const email = normaliseEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
    if (!isStrongPassword(body.password)) throw new HttpError(400, 'Password needs at least 8 characters with a letter and a number');
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) throw new HttpError(400, 'Enter the six-digit code');
    const ok = await consumeEmailOtp(env, email, code);
    if (!ok) {
      await recordAuthFailure(env, ip);
      throw new HttpError(401, 'That code is wrong or has expired');
    }
    const row = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`).bind(email).first();
    if (!row) throw new HttpError(401, 'That code is wrong or has expired');
    await setPassword(env, row.user_id, email, String(body.password));
    await deleteUserSessions(env, row.user_id);
    await clearAuthFailures(env, ip);
    await audit(env, { action: 'auth.password', actor: row.user_id, detail: 'otp' });
    return json({ ok: true });
  }

  const oauthCallback = path.match(/^\/api\/auth\/oauth\/callback\/([a-z]{1,20})$/);

  // Step 1 of the flow in src/oauth.js: hand the client a provider URL. The app
  // opens it in the system browser, never inside the WebView.
  if (path === '/api/auth/oauth/start' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    if (await hitRateLimit(env, `oauth:${clientIp(request)}`, 30, 600_000)) {
      throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
    }
    const body = await readJson(request);
    const provider = String(body.provider || '');
    // Fail here, with a useful message, when the provider has no credentials yet.
    providerOf(env, provider);
    const redirectUri = `${url.origin}/api/auth/oauth/callback/${provider}`;
    const started = await startAuthorization(env, { provider, redirectUri, returnTo: body.returnTo });
    return json({ ok: true, url: started.url });
  }

  // Step 2: the provider redirects here. The code is exchanged server-side and
  // the result is a one-time ticket, not a session: the browser that ran this
  // has its own cookie jar, and the app needs the ticket for its own.
  if (oauthCallback && method === 'GET') {
    const provider = oauthCallback[1];
    const back = new URL('/api/auth/oauth/finish', url.origin);
    if (url.searchParams.get('error')) {
      back.searchParams.set('signin', 'denied');
      return Response.redirect(back.toString(), 302);
    }
    try {
      const { token } = await exchangeCode(env, provider, {
        code: url.searchParams.get('code'),
        state: String(url.searchParams.get('state') || ''),
        redirectUri: `${url.origin}/api/auth/oauth/callback/${provider}`,
      });
      const identity = await fetchIdentity(env, provider, token);
      const { user, outcome } = await resolveOauthAccount(env, identity);
      const ticket = await issueLoginTicket(env, user.id);
      await audit(env, { action: 'auth.login', actor: user.id, detail: `${provider}:${outcome}` });
      back.searchParams.set('ticket', ticket);
      return new Response(null, { status: 302, headers: { Location: back.toString(), 'Cache-Control': 'no-store' } });
    } catch (err) {
      console.error('oauth sign-in failed', provider, err && err.message);
      back.searchParams.set('signin', err && err.status === 403 ? 'unverified' : 'failed');
      return new Response(null, { status: 302, headers: { Location: back.toString(), 'Cache-Control': 'no-store' } });
    }
  }

  // Step 3: redeem the ticket for a session in whichever agent ends up here.
  // The Android app intercepts this URL (see AndroidManifest) and loads it in
  // the WebView, so the cookie lands in the app's own jar.
  if (path === '/api/auth/oauth/finish' && method === 'GET') {
    const ticket = String(url.searchParams.get('ticket') || '');
    const failed = new URL('/', url.origin);
    if (url.searchParams.get('signin')) {
      failed.searchParams.set('signin', url.searchParams.get('signin'));
      return new Response(null, { status: 302, headers: { Location: failed.toString(), 'Cache-Control': 'no-store' } });
    }
    const userId = await consumeLoginTicket(env, ticket);
    if (!userId) {
      failed.searchParams.set('signin', 'expired');
      return new Response(null, { status: 302, headers: { Location: failed.toString(), 'Cache-Control': 'no-store' } });
    }
    const user = await getUser(env, userId).catch(() => null);
    if (!user) {
      failed.searchParams.set('signin', 'failed');
      return new Response(null, { status: 302, headers: { Location: failed.toString(), 'Cache-Control': 'no-store' } });
    }
    const session = await createSession(env, user.id, request);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/?signin=ok`,
        'Set-Cookie': sessionCookie(session, url),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const body = await readJson(request);
    const email = normaliseEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
    if (!isStrongPassword(body.password)) throw new HttpError(400, 'Password needs at least 8 characters with a letter and a number');
    if (await emailTaken(env, email)) throw new HttpError(409, 'That email already has an account');
    // An invite code is optional: with one you join that household, without one
    // you start a private planner of your own.
    const code = String(body.code || '').trim();
    const invite = code ? await checkInvite(env, code) : null;
    if (code && !invite) throw new HttpError(400, 'That invite code is not valid or has expired');
    let user;
    try {
      user = await createEmailUser(env, email, String(body.password), body.name, invite ? invite.household : null);
    } catch (err) {
      await recordAuthFailure(env, ip);
      throw err;
    }
    if (invite) await redeemInvite(env, invite.code, user.id);
    const recoveryCode = await createRecoveryCode(env, user.id);
    const token = await createSession(env, user.id, request);
    await audit(env, { action: 'auth.login', actor: user.id, detail: 'signup' });
    return json({ ok: true, user: { name: user.name, email: user.email }, recoveryCode }, 200, {
      'Set-Cookie': sessionCookie(token, url),
    });
  }

  if (path === '/api/auth/setup' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    if ((await countUsers(env)) > 0) throw new HttpError(403, 'This planner is already set up');
    if (await hitRateLimit(env, `setup:${clientIp(request)}`, 5, 3600_000)) {
      throw new HttpError(429, 'Too many setup attempts. Try again later.');
    }
    const body = await readJson(request);
    if (!PIN_RE.test(String(body.pin || ''))) throw new HttpError(400, 'PIN must be 4-12 digits');
    const user = await createUser(env, body.name, String(body.pin));
    await seedDatabase(env, user.id);
    // Shown once: it is the only way to reset a forgotten PIN later.
    const recoveryCode = await createRecoveryCode(env, user.id);
    const token = await createSession(env, user.id, request);
    return json({ ok: true, user: { name: user.name }, recoveryCode }, 200, {
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
        await audit(env, { action: 'auth.login_failed', detail: 'password' });
        throw new HttpError(401, 'Email or password is incorrect');
      }
    } else {
      const pin = String(body.pin || '');
      if (!PIN_RE.test(pin)) {
        await recordAuthFailure(env, ip);
        await audit(env, { action: 'auth.login_failed', detail: 'pin-format' });
        throw new HttpError(401, 'Incorrect PIN');
      }
      user = await verifyPin(env, pin);
      if (!user) {
        await recordAuthFailure(env, ip);
        await audit(env, { action: 'auth.login_failed', detail: 'pin' });
        throw new HttpError(401, 'Incorrect PIN');
      }
    }
    // Second factor: the password/PIN alone never creates a session when TOTP is
    // enabled. The reply says only that a code is needed, then the client posts
    // it back with the same credentials.
    if (await accountHasTotp(env, user.id)) {
      const code = String(body.code || '').replace(/\s/g, '');
      if (!code) return json({ twoFactor: true });
      if (!(await verifyTotp(env, user.id, code))) {
        await recordAuthFailure(env, ip);
        await audit(env, { action: 'auth.login_failed', actor: user.id, detail: 'totp' });
        throw new HttpError(401, 'That authenticator code is not valid');
      }
    }
    await clearAuthFailures(env, ip);
    const token = await createSession(env, user.id, request);
    await audit(env, { action: 'auth.login', actor: user.id, detail: body.email ? 'password' : 'pin' });
    return json({ ok: true, user }, 200, { 'Set-Cookie': sessionCookie(token, url) });
  }

  // Forgot PIN / password: a single-use recovery code is the only proof accepted
  // here, so knowing an email address or household name is not enough.
  if (path === '/api/auth/recover' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const body = await readJson(request);
    const pin = String(body.pin || '');
    if (!PIN_RE.test(pin)) throw new HttpError(400, 'Use 4-12 digits for the new PIN');
    const userId = await recoverWithCode(env, body.code, pin);
    if (!userId) {
      await recordAuthFailure(env, ip);
      throw new HttpError(401, 'That recovery code did not match any account');
    }
    await clearAuthFailures(env, ip);
    const fresh = await createRecoveryCode(env, userId);
    await audit(env, { action: 'auth.recovery', actor: userId });
    return json({ ok: true, recoveryCode: fresh });
  }

  if (path === '/api/auth/reset' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) {
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
    const body = await readJson(request);
    const email = normaliseEmail(body.email);
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
    if (!isStrongPassword(body.password)) throw new HttpError(400, 'Password needs at least 8 characters with a letter and a number');
    const pin = String(body.pin || '');
    if (!PIN_RE.test(pin)) {
      await recordAuthFailure(env, ip);
      throw new HttpError(401, 'Invalid PIN');
    }
    const pinUser = await verifyPin(env, pin);
    if (!pinUser) {
      await recordAuthFailure(env, ip);
      throw new HttpError(401, 'Invalid PIN or email');
    }
    // A planner created before email sign-in has a PIN and no credentials row at
    // all, so it could never sign in with an email and could never finish this
    // reset: the account was unreachable from either form. Proving the PIN is the
    // ownership proof this route already relies on, so the first address is
    // attached to that account. Once an address is attached it still has to match.
    const creds = await credentialsFor(env, pinUser.id);
    const attached = normaliseEmail(creds && creds.email);
    if (attached && attached !== email) {
      await recordAuthFailure(env, ip);
      throw new HttpError(401, 'Invalid PIN or email');
    }
    if (!attached) {
      const holder = await env.DB.prepare(`SELECT user_id FROM credentials WHERE email = ?`).bind(email).first();
      if (holder && holder.user_id !== pinUser.id) {
        throw new HttpError(409, 'That email already has another account');
      }
    }
    await setPassword(env, pinUser.id, email, String(body.password));
    await deleteUserSessions(env, pinUser.id);
    await clearAuthFailures(env, ip);
    await audit(env, { action: 'auth.password_reset', actor: pinUser.id });
    return json({ ok: true });
  }

  // Re-checks the secret behind a locked screen without issuing a new session. The
  // sign-in forms cannot be used for this: an email-only account has no PIN to type
  // into the lock screen, and a full login would rotate the cookie on every unlock.
  if (path === '/api/auth/verify' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
    const { session } = await requireUser(request, env, url);
    const body = await readJson(request);
    let ok = false;
    if (body.password) {
      const creds = await credentialsFor(env, session.userId);
      if (creds && creds.email) {
        const user = await verifyPassword(env, creds.email, String(body.password));
        ok = Boolean(user && user.id === session.userId);
      }
    } else {
      ok = await verifyUserPin(env, session.userId, String(body.pin || ''));
    }
    if (!ok) {
      await recordAuthFailure(env, ip);
      throw new HttpError(401, 'That PIN or password is incorrect');
    }
    await clearAuthFailures(env, ip);
    return json({ ok: true });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const session = await getSession(env, readCookie(request, COOKIE));
    await deleteSession(env, readCookie(request, COOKIE));
    if (session) await audit(env, { action: 'auth.logout', actor: session.userId });
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(url) });
  }

  if (path === '/api/auth/lock' && method === 'POST') {
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-origin request blocked');
    const session = await getSession(env, readCookie(request, COOKIE));
    await deleteSession(env, readCookie(request, COOKIE));
    if (session) await audit(env, { action: 'auth.lock', actor: session.userId });
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(url) });
  }

  /* ------------------------------------------------------- calendar feed */

  // A calendar app subscribes with a plain GET and no cookie, so the token in the
  // path is the credential. It is unguessable (24 random bytes), revocable from
  // Settings, and serves only books the account is a member of.
  const feedMatch = path.match(/^\/api\/calendar\/([0-9a-f]{48})\.ics$/);
  if (feedMatch && method === 'GET') {
    const body = await calendarFeed(env, feedMatch[1]);
    if (body == null) return json({ error: 'Unknown calendar URL' }, 404);
    return new Response(body, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline; filename="family-planner.ics"',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }

  // Telegram posts updates here. They carry no session and no Origin header, so
  // the request is authenticated by the secret token Telegram echoes back. An
  // update is acknowledged with 200 once handled: a non-2xx makes Telegram retry,
  // and the update id is recorded so a retry is not acted on twice.
  if (path === '/api/telegram/webhook' && method === 'POST') {
    if (!telegramWebhookConfigured(env)) {
      return json({ error: 'Telegram is not configured (TELEGRAM_WEBHOOK_SECRET).' }, 501);
    }
    if (!webhookSecretOk(env, request.headers.get('X-Telegram-Bot-Api-Secret-Token'))) {
      return json({ error: 'Bad webhook secret' }, 401);
    }
    const raw = await request.text();
    if (raw.length > 100_000) return json({ error: 'Body too large' }, 413);
    let update;
    try {
      update = JSON.parse(raw || '{}');
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const updateId = String(update && update.update_id != null ? update.update_id : '');
    if (updateId) {
      const first = await env.DB.prepare(`INSERT OR IGNORE INTO telegram_updates (id, at) VALUES (?, ?)`)
        .bind(updateId, Date.now())
        .run();
      if (!((first.meta && first.meta.changes) || 0)) return json({ ok: true, duplicate: true });
    }
    const from = String((update && update.message && update.message.from && update.message.from.id) || '');
    if (from && (await hitRateLimit(env, `tg:${from}`, 30, 60_000))) {
      return json({ ok: true, throttled: true });
    }
    let reply = '';
    try {
      reply = await handleUpdate(env, update);
    } catch (err) {
      console.error('telegram update failed', err && err.message ? String(err.message).slice(0, 200) : 'unknown');
      reply = 'Something went wrong. Try again in a moment.';
    }
    // Best effort: a send failure must not turn into a Telegram retry loop.
    if (reply) {
      const chatId = update && update.message && update.message.chat && update.message.chat.id;
      if (chatId) await sendMessage(env, chatId, reply).catch(() => {});
    }
    return json({ ok: true });
  }

  const { session, token } = await requireUser(request, env, url);

  // Every authenticated mutation shares a per-user allowance; auth routes have
  // their own stricter limiter and are excluded here.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !path.startsWith('/api/auth/')) {
    await enforceWriteLimit(env, session.userId);
  }

  // Authorise before any handler runs. The profile id comes from the client, so
  // membership is proved against profile_members every single request; a forged
  // or foreign id answers 404 instead of leaking another profile's data.
  const requested = requestSpace(request, session);
  const need = permissionFor(method, path);
  let profile = null;
  let space = requested;
  if (need) {
    profile = await resolveProfile(env, session, requested, need);
    space = profile.id;
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const body = await readJson(request);
    const email = normaliseEmail(body.email || (await credentialsFor(env, session.userId))?.email || '');
    if (!isEmail(email)) throw new HttpError(400, 'Enter the email to sign in with');
    if (!isStrongPassword(body.next)) throw new HttpError(400, 'Password needs at least 8 characters with a letter and a number');
    // Changing the address to one that already has an account used to reach the
    // UNIQUE index and answer 500. Refuse it before touching the row.
    const own = await credentialsFor(env, session.userId);
    if (email !== normaliseEmail(own && own.email)) {
      if (await emailTaken(env, email)) throw new HttpError(409, 'That email already has an account');
    }
    const current = String(body.current || '');
    // Verify against the address already on the account: the submitted one is the
    // destination and must never be used to look up a credential. Accounts that only
    // have a PIN (no email yet) authorise with that PIN instead.
    const storedEmail = normaliseEmail(own && own.email);
    const byPassword = storedEmail ? await verifyPassword(env, storedEmail, current) : null;
    // Only this account's own PIN can authorise the change, never another member's.
    const byPin = byPassword ? false : await verifyUserPin(env, session.userId, current);
    if (!byPassword && !byPin) throw new HttpError(401, 'Current password is incorrect');
    await setPassword(env, session.userId, email, String(body.next));
    await deleteUserSessions(env, session.userId, session.sessionId);
    await audit(env, { action: 'auth.password', actor: session.userId });
    return json({ ok: true, email });
  }

  if (path === '/api/auth/account' && method === 'PATCH') {
    const body = await readJson(request);
    const name = await updateAccountName(env, session.userId, body.name);
    return json({ ok: true, name });
  }

  if (path === '/api/calendar/feed' && method === 'GET') {
    const target = await resolveProfile(env, session, url.searchParams.get('profile'), 'view');
    const token = await calendarToken(env, session.userId, target.id);
    return json({
      url: new URL(`/api/calendar/${token}.ics`, url.origin).toString(),
      profile: target.id,
      profileName: target.name,
    });
  }

  if (path === '/api/calendar/feed' && method === 'POST') {
    const target = await resolveProfile(env, session, url.searchParams.get('profile'), 'view');
    const token = await calendarToken(env, session.userId, target.id, { rotate: true });
    await audit(env, { action: 'calendar.rotate', actor: session.userId, profileId: target.id });
    return json({
      url: new URL(`/api/calendar/${token}.ics`, url.origin).toString(),
      profile: target.id,
      profileName: target.name,
    });
  }

  if (path === '/api/auth/account' && method === 'GET') {
    const creds = await credentialsFor(env, session.userId);
    const profiles = await listProfiles(env, session.userId);
    const current = profiles.find((p) => p.id === (session.household || 'family')) || profiles[0] || null;
    const user = await getUser(env, session.userId);
    return json({
      name: session.name,
      twoFactor: Boolean(user && user.totp_enabled),
      hasRecovery: Boolean(user && user.has_recovery),
      email: creds ? creds.email : null,
      role: current ? current.role : 'viewer',
      roles: ROLE_LABEL,
      encryption: await encryptionReady(env),
      spaces: ['family', 'personal', 'office'],
      profiles,
      storage: Boolean(env.FILES),
      ai: Boolean(await activeAiConnection(env, session.household || 'family')),
      version: APP_VERSION,
      api: API_VERSION,
    });
  }

  /* ----------------------------------------------------------- profiles */

  if (path === '/api/profiles' && method === 'GET') {
    const profiles = await listProfiles(env, session.userId);
    return json({ profiles, roles: ROLE_LABEL });
  }

  if (path === '/api/profiles/switch' && method === 'POST') {
    const body = await readJson(request);
    // resolveProfile throws 404 for a profile the account cannot see, so this
    // cannot be used to probe for other households' profile ids.
    const target = await resolveProfile(env, session, String(body.profile || ''), 'view');
    await audit(env, {
      action: 'profile.switch',
      actor: session.userId,
      profileId: target.id,
      target: target.kind,
    });
    return json({
      ok: true,
      profile: { id: target.id, kind: target.kind, name: target.name, role: target.role },
    });
  }

  const profileMembersMatch = path.match(/^\/api\/profiles\/([^/]{1,120})\/members(?:\/([^/]{1,64}))?$/);
  if (profileMembersMatch) {
    const profileId = decodeURIComponent(profileMembersMatch[1]);
    const targetId = profileMembersMatch[2] ? decodeURIComponent(profileMembersMatch[2]) : null;
    const own = await resolveProfile(env, session, profileId, method === 'GET' ? 'view' : 'manage');
    if (method === 'GET' && !targetId) {
      return json({ members: await profileMembers(env, own.id), profile: { id: own.id, name: own.name, kind: own.kind }, me: session.userId });
    }
    if (method === 'PATCH' && targetId) {
      const body = await readJson(request);
      if (!isRole(body.role)) throw new HttpError(400, 'Unknown role');
      const out = await setMemberRole(env, own.id, session.userId, targetId, String(body.role));
      await audit(env, {
        action: 'profile.role',
        actor: session.userId,
        profileId: own.id,
        target: targetId,
        detail: out.role,
      });
      return json({ ok: true, ...out });
    }
  }

  if (path === '/api/audit' && method === 'GET') {
    return json({ events: await listAudit(env, space, url.searchParams.get('limit') || 60) });
  }

  if (path === '/api/notifications/all' && method === 'GET') {
    const profiles = await listProfiles(env, session.userId);
    const readable = profiles.filter((p) => p.role !== undefined);
    const rows = await listNotificationsAcross(env, readable.map((p) => p.id), 100);
    const names = Object.fromEntries(readable.map((p) => [p.id, p.name]));
    return json({
      notifications: rows.map((n) => ({ ...n, profile_name: names[n.space] || n.space })),
      total: rows.filter((n) => !n.read_at).length,
      profiles: readable.map((p) => ({ id: p.id, name: p.name, kind: p.kind, unread: p.unread })),
    });
  }

  if (path === '/api/auth/pin' && method === 'POST') {
    // The PIN unlocks the whole household, so rewriting it needs the same right
    // as any other household-wide change. A viewer who knows the current PIN
    // must not be able to lock the owner out.
    await resolveProfile(env, session, session.household || 'family', 'manage');
    const body = await readJson(request);
    if (!PIN_RE.test(String(body.newPin || ''))) throw new HttpError(400, 'PIN must be 4-12 digits');
    const ok = await verifyPin(env, String(body.currentPin || ''));
    if (!ok) throw new HttpError(401, 'Current PIN is incorrect');
    await updatePin(env, String(body.newPin));
    await deleteUserSessions(env, session.userId, session.sessionId);
    return json({ ok: true });
  }

  /* --------------------------------------------- account security (2fa) */

  if (path === '/api/auth/recovery' && method === 'POST') {
    const recoveryCode = await createRecoveryCode(env, session.userId);
    await audit(env, { action: 'auth.recovery_code', actor: session.userId });
    return json({ ok: true, recoveryCode });
  }

  if (path === '/api/auth/2fa' && method === 'GET') {
    return json(await totpState(env, session.userId));
  }

  if (path === '/api/auth/2fa/start' && method === 'POST') {
    const creds = await credentialsFor(env, session.userId);
    const account = creds ? creds.email : session.name;
    const started = await beginTotp(env, session.userId, account);
    return json({ ok: true, ...started });
  }

  if (path === '/api/auth/2fa/enable' && method === 'POST') {
    const body = await readJson(request);
    await enableTotp(env, session.userId, body.code);
    // A lost phone must not mean a lost account, so enabling 2FA also issues a
    // recovery code that resets the PIN without any authenticator.
    const recoveryCode = await createRecoveryCode(env, session.userId);
    await audit(env, { action: 'auth.2fa', actor: session.userId, detail: 'enabled' });
    return json({ ok: true, recoveryCode });
  }

  if (path === '/api/auth/2fa/disable' && method === 'POST') {
    const body = await readJson(request);
    if (await accountHasTotp(env, session.userId)) {
      if (!(await verifyTotp(env, session.userId, body.code))) {
        throw new HttpError(401, 'Enter a current authenticator code to turn 2FA off');
      }
    }
    await disableTotp(env, session.userId);
    await audit(env, { action: 'auth.2fa', actor: session.userId, detail: 'disabled' });
    return json({ ok: true });
  }

  /* ----------------------------------------------------------- telegram */

  if (path === '/api/telegram' && method === 'GET') {
    const link = await linkForUser(env, session.userId);
    return json({
      configured: telegramConfigured(env),
      // The app shows exactly which secret the owner still has to add.
      missing: telegramMissing(env),
      link: link
        ? {
            username: link.username,
            // The numeric id is shown so a person can recognise the chat, never
            // to be typed back in as proof of anything.
            telegramUserId: String(link.telegram_user_id).replace(/^(.{2}).*(.{2})$/, '$1•••$2'),
            preview: link.preview,
            linkedAt: link.created_at,
            blocked: Boolean(link.blocked_at),
          }
        : null,
    });
  }

  if (path === '/api/telegram/link' && method === 'POST') {
    assertTelegramConfigured(env);
    const out = await createLinkCode(env, session.userId);
    await audit(env, { action: 'auth.telegram', actor: session.userId, detail: 'code' });
    // The code is not stored anywhere in readable form, so this response is the
    // only copy: it must never be cached or logged.
    return json({ ok: true, code: out.code, minutes: out.minutes }, 200, { 'Cache-Control': 'no-store' });
  }

  if (path === '/api/telegram/unlink' && method === 'POST') {
    const had = await unlinkTelegram(env, session.userId);
    await audit(env, { action: 'auth.telegram', actor: session.userId, detail: 'unlink' });
    return json({ ok: true, unlinked: had });
  }

  if (path === '/api/telegram/prefs' && method === 'POST') {
    const body = await readJson(request);
    const preview = await setPreview(env, session.userId, String(body.preview || ''));
    await audit(env, { action: 'auth.telegram', actor: session.userId, detail: `preview:${preview}` });
    return json({ ok: true, preview });
  }

  /* -------------------------------------------------- cloud backup */
  // The token that keeps a drive connected never leaves the Worker: the response
  // says whether a provider is configured and linked, never how.

  if (path === '/api/cloud' && method === 'GET') {
    const rows = (await env.DB.prepare(
      `SELECT provider, created_at, last_backup_at FROM cloud_links WHERE user_id = ?`,
    )
      .bind(session.userId)
      .all()).results || [];
    const linked = Object.fromEntries(rows.map((r) => [r.provider, r]));
    const settings = (await env.DB.prepare(
      `SELECT provider, enabled, frequency, keep, last_run_at FROM backup_settings WHERE user_id = ?`,
    )
      .bind(session.userId)
      .first()) || { provider: null, enabled: 0, frequency: 'daily', keep: 7, last_run_at: null };
    const runs = (await env.DB.prepare(
      `SELECT provider, filename, sha256, bytes, created_at, trigger FROM backup_runs
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
    )
      .bind(session.userId)
      .all()).results || [];
    return json({
      providers: providerInfo(env).map((p) => ({
        ...p,
        linkedAt: linked[p.id] ? linked[p.id].created_at : null,
        lastBackupAt: linked[p.id] ? linked[p.id].last_backup_at : null,
      })),
      settings: {
        provider: settings.provider || null,
        enabled: Boolean(settings.enabled),
        frequency: settings.frequency || 'daily',
        keep: Number(settings.keep) || 7,
        lastRunAt: settings.last_run_at || null,
      },
      runs,
      keyConfigured: backupKeyConfigured(env),
    });
  }

  if (path === '/api/cloud/settings' && method === 'POST') {
    const body = await readJson(request);
    const frequency = ['daily', 'weekly'].includes(String(body.frequency)) ? String(body.frequency) : 'daily';
    const keep = Math.min(60, Math.max(1, Number(body.keep) || 7));
    const enabled = body.enabled ? 1 : 0;
    const provider = body.provider ? String(body.provider) : null;
    if (provider && !CLOUD_PROVIDER_IDS.has(provider)) throw new HttpError(400, 'Unknown backup provider');
    if (enabled) {
      const saved = await env.DB.prepare(`SELECT 1 AS ok FROM cloud_links WHERE user_id = ? AND provider = ?`)
        .bind(session.userId, provider || '')
        .first();
      if (!saved) throw new HttpError(400, 'Connect that drive before turning automatic backup on');
      if (!backupKeyConfigured(env)) throw new HttpError(501, 'BACKUP_KEY is not set, so tokens cannot be stored safely');
    }
    await env.DB.prepare(
      `INSERT INTO backup_settings (user_id, provider, enabled, frequency, keep, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, enabled = excluded.enabled,
         frequency = excluded.frequency, keep = excluded.keep, updated_at = excluded.updated_at`,
    )
      .bind(session.userId, provider, enabled, frequency, keep, Date.now())
      .run();
    return json({ ok: true, settings: { provider, enabled: Boolean(enabled), frequency, keep } });
  }

  if (path === '/api/cloud/link' && method === 'POST') {
    if (!backupKeyConfigured(env)) {
      throw new HttpError(501, 'BACKUP_KEY is not set on this deployment, so a drive connection cannot be stored safely.');
    }
    const body = await readJson(request);
    const provider = String(body.provider || '');
    const redirectUri = `${url.origin}/api/cloud/callback/${provider}`;
    const started = await startConnect(env, provider, session.userId, redirectUri);
    return json({ ok: true, url: started.url });
  }

  if (path === '/api/cloud/unlink' && method === 'POST') {
    const body = await readJson(request);
    const provider = String(body.provider || '');
    await env.DB.prepare(`DELETE FROM cloud_links WHERE user_id = ? AND provider = ?`)
      .bind(session.userId, provider)
      .run();
    await env.DB.prepare(`UPDATE backup_settings SET enabled = 0 WHERE user_id = ? AND provider = ?`)
      .bind(session.userId, provider)
      .run();
    await audit(env, { action: 'backup.unlink', actor: session.userId, target: provider });
    return json({ ok: true });
  }

  const cloudCallback = path.match(/^\/api\/cloud\/callback\/([a-z]{1,20})$/);
  if (cloudCallback && method === 'GET') {
    const provider = cloudCallback[1];
    // Back to the app root, not /settings: the server only serves the shell at /,
    // so the old target answered 404 and a finished connection looked like a crash.
    const back = new URL('/', url.origin);
    back.searchParams.set('tab', 'settings');
    if (url.searchParams.get('error')) {
      back.searchParams.set('cloud', 'denied');
      return new Response(null, { status: 302, headers: { Location: back.toString(), 'Cache-Control': 'no-store' } });
    }
    try {
      const linked = await finishConnect(env, provider, url.searchParams.get('code'), url.searchParams.get('state'));
      // A state belongs to the account that asked for it; a callback carrying
      // another account's state must never write a connection onto this session.
      if (linked.userId !== session.userId) throw new HttpError(400, 'That connection belongs to another account');
      await env.DB.prepare(
        `INSERT INTO cloud_links (user_id, provider, refresh_token, access_token, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, expires_at = excluded.expires_at`,
      )
        .bind(linked.userId, linked.provider, linked.sealedRefresh, linked.accessToken, linked.expiresAt, Date.now())
        .run();
      await audit(env, { action: 'backup.link', actor: session.userId, target: provider });
      back.searchParams.set('cloud', 'connected');
    } catch (err) {
      console.error('cloud connect failed', provider, err && err.message);
      back.searchParams.set('cloud', 'failed');
    }
    return new Response(null, { status: 302, headers: { Location: back.toString(), 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/cloud/backup' && method === 'POST') {
    if (!backupKeyConfigured(env)) throw new HttpError(501, 'BACKUP_KEY is not set on this deployment.');
    const body = await readJson(request);
    const provider = String(body.provider || '');
    const out = await runBackup(env, { userId: session.userId, provider, trigger: 'manual', appVersion: APP_VERSION });
    await audit(env, { action: 'backup.create', actor: session.userId, target: provider, detail: out.filename });
    return json(out);
  }

  if (path === '/api/cloud/backups' && method === 'GET') {
    const provider = String(url.searchParams.get('provider') || '');
    const saved = await cloudLink(env, session.userId, provider);
    if (!saved) throw new HttpError(400, 'Connect that drive first');
    const files = await listBackups(env, saved);
    return json({ provider, files: files.slice(0, 30) });
  }

  if (path === '/api/cloud/restore' && method === 'POST') {
    const body = await readJson(request);
    const provider = String(body.provider || '');
    let payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
    if (!payload) {
      if (!backupKeyConfigured(env)) throw new HttpError(501, 'BACKUP_KEY is not set on this deployment.');
      const fileId = String(body.fileId || '');
      if (!fileId) throw new HttpError(400, 'Choose a backup to restore');
      const saved = await cloudLink(env, session.userId, provider);
      if (!saved) throw new HttpError(400, 'Connect that drive first');
      const text = await downloadBackup(env, saved, fileId);
      try {
        payload = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'That backup is not valid JSON');
      }
    }
    const stats = await restoreExport(env, session.userId, payload);
    if (provider) {
      await env.DB.prepare(
        `INSERT INTO backup_runs (id, user_id, provider, filename, sha256, bytes, created_at, trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'restore')`,
      )
        .bind(
          crypto.randomUUID(),
          session.userId,
          provider,
          String(payload.createdAt || ''),
          String((payload.checksum && payload.checksum.value) || ''),
          0,
          Date.now(),
        )
        .run();
    }
    await audit(env, {
      action: 'backup.restore',
      actor: session.userId,
      target: provider || 'upload',
      detail: `${stats.records} records`,
    });
    return json({ ok: true, ...stats });
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
    const profiles = await listProfiles(env, session.userId);
    return json({
      ...state,
      me: { name: session.name },
      spaces: ['family', 'personal', 'office'],
      profiles,
      profile: { id: profile.id, kind: profile.kind, name: profile.name, role: profile.role },
      permissions: ['view', 'create', 'update', 'delete', 'export', 'manage', 'share'],
      version: APP_VERSION,
    });
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
    const saved = await saveSubscription(env, body, request.headers.get('User-Agent'), session.userId);
    if (!saved) throw new HttpError(400, 'Invalid push subscription');
    return json({ ok: true });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readJson(request);
    // Scoped to the caller: an endpoint id belonging to another account is a
    // no-op instead of a cross-tenant delete.
    await removeSubscription(env, body.endpoint, session.userId);
    return json({ ok: true });
  }

  if (path === '/api/push/test' && method === 'POST') {
    return json(await sendTestPush(env, session.userId));
  }

  if (path === '/api/settings' && method === 'POST') {
    const body = await readJson(request);
    const clean = {
      alertTime: /^\d{2}:\d{2}$/.test(String(body.alertTime || '')) ? body.alertTime : '06:00',
      channel: String(body.channel || '').slice(0, 80),
      currency: 'INR',
      household: String(body.household || '').slice(0, 80),
    };
    // Settings are per profile so one household's contact number and alert
    // channel never surface inside another profile's screens.
    await setMeta(env, `settings:${space}`, clean);
    await audit(env, { action: 'settings.update', actor: session.userId, profileId: space });
    return json({ ok: true, settings: clean });
  }

  if (path === '/api/records' && method === 'POST') {
    const body = await readJson(request);
    assertSpaceCollection(space, body.collection);
    const out = await createRecord(env, space, String(body.collection || ''), body.doc || {}, session.userId);
    ctx.waitUntil(runBackground(env));
    return json(out);
  }

  if (path === '/api/records/bulk' && method === 'POST') {
    const body = await readJson(request);
    const collection = String(body.collection || '');
    if (!COLLECTIONS[collection]) throw new HttpError(400, 'Unknown collection');
    assertSpaceCollection(space, collection);
    const dedupeKey =
      collection === 'contacts'
        ? (doc) => {
            const digits = String(doc.mobile || '').replace(/\D/g, '');
            return digits.length >= 10 ? digits.slice(-10) : '';
          }
        : null;
    const stats = await bulkCreate(env, space, collection, body.docs || [], session.userId, dedupeKey);
    if (body.restore === true) {
      await audit(env, {
        action: 'data.restore',
        actor: session.userId,
        profileId: space,
        target: collection,
        detail: `${stats.added} rows`,
      });
    }
    ctx.waitUntil(runBackground(env));
    return json(stats);
  }

  const recordMatch = path.match(/^\/api\/records\/([a-zA-Z]+)\/([A-Za-z0-9_-]{1,64})$/);
  if (recordMatch) {
    const collection = recordMatch[1];
    const id = recordMatch[2];
    assertSpaceCollection(space, collection);
    if (method === 'PATCH') {
      const body = await readJson(request);
      const out = await updateRecord(env, space, collection, id, body.doc || {}, session.userId);
      ctx.waitUntil(runBackground(env));
      return json(out);
    }
    if (method === 'DELETE') {
      const out = await deleteRecord(env, space, collection, id, session.userId);
      await audit(env, {
        action: 'record.delete',
        actor: session.userId,
        profileId: space,
        target: `${collection}/${id}`,
      });
      ctx.waitUntil(runBackground(env));
      return json(out);
    }
  }

  if (path === '/api/export' && method === 'GET') {
    // A stolen session must not be able to pull the ledger thousands of times.
    if (await hitRateLimit(env, `x:${session.userId}`, 30, 3600_000)) {
      throw new HttpError(429, 'Too many exports in the last hour. Wait before exporting again.');
    }
    const out = {
      exportedAt: new Date().toISOString(),
      profile: { id: profile.id, kind: profile.kind, name: profile.name },
      settings: await getMeta(env, `settings:${space}`, null),
      data: {},
    };
    for (const name of COLLECTION_NAMES) out.data[name] = await listCollection(env, space, name);
    await audit(env, { action: 'data.export', actor: session.userId, profileId: space });
    return json(out, 200, {
      'Content-Disposition': `attachment; filename="family-finance-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  // Records that a backup was created or restored. The backup itself is
  // encrypted in the browser, so the worker only ever sees this audit line.
  if (path === '/api/backup' && method === 'POST') {
    const body = await readJson(request);
    const restore = body.action === 'restore';
    await audit(env, {
      action: restore ? 'backup.restore' : 'backup.create',
      actor: session.userId,
      profileId: space,
      target: String(body.target || 'download').slice(0, 60),
      detail: `${Math.min(Number(body.bytes) || 0, 1e9)} bytes`,
    });
    return json({ ok: true });
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
    const rows = await listAiConnections(env, space);
    return json({ connections: rows.map((r) => ({ ...r, apiKey: undefined, masked: '••••' })) });
  }

  if (path === '/api/ai/connections' && method === 'POST') {
    const body = await readJson(request);
    const created = await addAiConnection(env, body, session.userId, space);
    return json({ ok: true, connection: created });
  }

  const aiMatch = path.match(/^\/api\/ai\/connections\/([0-9a-f-]{36})(\/test)?$/);
  if (aiMatch) {
    if (method === 'DELETE' && !aiMatch[2]) {
      await deleteAiConnection(env, aiMatch[1], space);
      return json({ ok: true });
    }
    if (method === 'POST' && aiMatch[2]) {
      const connection = await activeAiConnection(env, space);
      if (!connection || connection.id !== aiMatch[1]) throw new HttpError(404, 'Connection not found');
      return json(await testConnection(connection));
    }
  }

  /* ------------------------------------------------------------ family */

  if (path === '/api/family/members' && method === 'GET') {
    return json({
      members: await profileMembers(env, space),
      me: session.userId,
      role: profile.role,
      household: space,
      permissions: {
        manage: profile.role === 'owner' || profile.role === 'admin',
        share: profile.role === 'owner',
      },
    });
  }

  if (path === '/api/family/invite' && method === 'POST') {
    const invite = await createInvite(env, session.userId, space);
    await audit(env, {
      action: 'share.invite',
      actor: session.userId,
      profileId: space,
      target: invite.code ? 'code-issued' : 'failed',
    });
    return json({ ok: true, ...invite });
  }

  const memberMatch = path.match(/^\/api\/family\/members\/([0-9a-f-]{36})$/);
  if (memberMatch && method === 'DELETE') {
    if (profile.owner_id && memberMatch[1] === profile.owner_id) {
      throw new HttpError(400, 'The profile owner cannot be removed');
    }
    if (memberMatch[1] === session.userId) throw new HttpError(400, 'You cannot remove your own account');
    await removeMember(env, memberMatch[1], space, session.userId);
    await audit(env, {
      action: 'share.revoke',
      actor: session.userId,
      profileId: space,
      target: memberMatch[1],
    });
    return json({ ok: true });
  }

  /* ------------------------------------------------- migration snapshot */

  // Owner-only, read-only dump of everything a migration must carry. Deployed only
  // for the duration of the move; see migration/SECURITY_CHECKLIST.md.
  // This dump contains password hashes and the VAPID private key, so it only
  // exists while a migration is explicitly switched on. Without the flag the
  // route behaves as if it were never deployed.
  if (path === '/api/admin/snapshot' && method === 'GET') {
    if (String(env.MIGRATION_MODE || '') !== '1') throw new HttpError(404, 'Not found');
    if ((await memberRole(env, session.userId)) !== 'owner') {
      throw new HttpError(403, 'Only the household owner can export a snapshot');
    }
    const snapshot = await exportSnapshot(env);
    return json(snapshot, 200, {
      'Content-Disposition': `attachment; filename="family-planner-snapshot-${snapshot.exportedAt.replace(/[:.]/g, '-')}.json"`,
      'Cache-Control': 'no-store',
    });
  }

  if (path === '/api/admin/reset' && method === 'POST') {
    await wipeRecords(env, space);
    await seedDatabase(env, session.userId, space);
    await audit(env, { action: 'data.restore', actor: session.userId, profileId: space, target: 'reset' });
    return json({ ok: true });
  }

  if (path === '/api/admin/clear' && method === 'POST') {
    await wipeRecords(env, space);
    await audit(env, { action: 'data.clear', actor: session.userId, profileId: space });
    return json({ ok: true });
  }

  if (path === '/api/admin/sample' && method === 'POST') {
    await wipeRecords(env, space);
    await seedDatabase(env, session.userId, space);
    await audit(env, { action: 'data.restore', actor: session.userId, profileId: space, target: 'sample' });
    return json({ ok: true });
  }

  if (path === '/api/events' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    // The stream follows the profile this request was authorised for; a `space`
    // query parameter is intentionally ignored so it cannot select another book.
    return streamEvents(env, since, space);
  }

  throw new HttpError(404, 'Not found');
}

function pathOf(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '?';
  }
}

/**
 * Read every migratable table into one object. Paginated with keyset cursors so a large
 * ledger cannot exhaust Worker memory, and so concurrent writes during the export cannot
 * make rows silently shift between pages the way OFFSET would. Read-only by construction.
 */
async function exportSnapshot(env) {
  const all = async (sql, bind = []) => (await env.DB.prepare(sql).bind(...bind).all()).results || [];

  const pageLoop = async (first, step, advance) => {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 400; page += 1) {
      const batch = cursor ? await all(step, cursor) : await all(first);
      rows.push(...batch);
      if (batch.length < SNAPSHOT_PAGE) break;
      cursor = advance(batch[batch.length - 1]);
    }
    return rows;
  };

  const tables = {};
  for (const name of SNAPSHOT_TABLES) tables[name] = [];

  // Small tables: a single read is enough and keeps the code obvious.
  tables.meta = await all('SELECT * FROM meta ORDER BY k');
  tables.users = await all('SELECT * FROM users ORDER BY created_at, id');
  tables.credentials = await all('SELECT * FROM credentials ORDER BY created_at, user_id');
  tables.push_subs = await all('SELECT * FROM push_subs ORDER BY created_at, id');
  tables.files = await all('SELECT * FROM files ORDER BY created_at, id');
  tables.ai_connections = await all('SELECT * FROM ai_connections ORDER BY created_at, id');
  tables.family_invites = await all('SELECT * FROM family_invites ORDER BY expires_at, code');
  tables.profiles = await all('SELECT * FROM profiles ORDER BY created_at, id');
  tables.profile_members = await pageLoop(
    `SELECT * FROM profile_members ORDER BY profile_id, user_id LIMIT ${SNAPSHOT_PAGE}`,
    `SELECT * FROM profile_members WHERE (profile_id, user_id) > (?, ?) ORDER BY profile_id, user_id LIMIT ${SNAPSHOT_PAGE}`,
    (row) => [row.profile_id, row.user_id],
  );
  tables.audit_log = await pageLoop(
    `SELECT * FROM audit_log ORDER BY id LIMIT ${SNAPSHOT_PAGE}`,
    `SELECT * FROM audit_log WHERE id > ? ORDER BY id LIMIT ${SNAPSHOT_PAGE}`,
    (row) => [row.id],
  );

  tables.records = await pageLoop(
    `SELECT * FROM records ORDER BY space, collection, id LIMIT ${SNAPSHOT_PAGE}`,
    `SELECT * FROM records WHERE (space, collection, id) > (?, ?, ?) ORDER BY space, collection, id LIMIT ${SNAPSHOT_PAGE}`,
    (row) => [row.space, row.collection, row.id],
  );
  tables.changes = await pageLoop(
    `SELECT * FROM changes ORDER BY seq LIMIT ${SNAPSHOT_PAGE}`,
    `SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ${SNAPSHOT_PAGE}`,
    (row) => [row.seq],
  );
  tables.notifications = await pageLoop(
    `SELECT * FROM notifications ORDER BY created_at, id LIMIT ${SNAPSHOT_PAGE}`,
    `SELECT * FROM notifications WHERE (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ${SNAPSHOT_PAGE}`,
    (row) => [row.created_at, row.id],
  );

  const counts = {};
  for (const name of SNAPSHOT_TABLES) counts[name] = tables[name].length;
  const schemaRow = tables.meta.find((row) => row.k === 'schema');

  return { exportedAt: new Date().toISOString(), schema: schemaRow ? schemaRow.v : null, counts, tables };
}

async function runBackground(env) {
  try {
    await sweep(env);
    await pruneChanges(env);
  } catch {
    /* background maintenance must never break a request */
  }
  try {
    await deliverPending(env);
  } catch {
    /* a queued Telegram alert is retried by the next drain or the cron */
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
