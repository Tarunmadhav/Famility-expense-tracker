// End-to-end API smoke test against a running Worker (default http://127.0.0.1:8787).
// Usage: node scripts/smoke.mjs [baseUrl]

import { esc } from '../web/src/format.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
let cookie = '';
let failures = 0;

function ok(name, condition, extra = '') {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

async function call(path, { method = 'GET', body, headers: extra } = {}) {
  const headers = { Accept: 'application/json', ...(extra || {}) };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const health = await call('/api/health');
ok('health responds', health.status === 200 && health.data.ok === true, JSON.stringify(health.data));

const status0 = await call('/api/auth/status');
ok('auth status reachable', status0.status === 200, JSON.stringify(status0.data));

const unauthed = await call('/api/state');
ok('state requires a session', unauthed.status === 401, `got ${unauthed.status}`);

if (!status0.data.configured) {
  const setup = await call('/api/auth/setup', { method: 'POST', body: { name: 'Smoke Household', pin: '135790' } });
  ok('setup creates the planner', setup.status === 200, JSON.stringify(setup.data));
} else {
  const login = await call('/api/auth/login', { method: 'POST', body: { pin: process.env.FFP_PIN || '135790' } });
  ok('login with existing PIN', login.status === 200, JSON.stringify(login.data));
}

const badLogin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  body: JSON.stringify({ pin: '000000' }),
});
ok('cross-origin login is rejected', badLogin.status === 403, `got ${badLogin.status}`);

const state = await call('/api/state?since=0');
ok('state returns collections', state.status === 200 && state.data.collections && state.data.collections.payments.length > 0, JSON.stringify(state.data?.error || ''));
ok('KPI source data present', state.data.collections.budgetEx.length === 10);
ok('notifications generated', Array.isArray(state.data.notifications), 'missing notifications array');
ok('push public key exposed', typeof state.data.pushPublicKey === 'string' && state.data.pushPublicKey.length > 40);
const startRev = state.data.rev;

const created = await call('/api/records', {
  method: 'POST',
  body: {
    collection: 'expenses',
    doc: {
      date: '2026-11-01',
      item: 'Smoke test <script>alert(1)</script>',
      cat: 'Testing',
      method: 'Cash',
      amount: 123.45,
      status: 'Paid',
      merchant: 'Smoke',
      phone: '9999999999',
      ref: 'SMOKE-1',
      remarks: '',
      malicious: 'should be dropped',
    },
  },
});
ok('record created', created.status === 200 && created.data.record.id, JSON.stringify(created.data));
ok('text stored verbatim (escaped at render)', created.data.record.item === 'Smoke test <script>alert(1)</script>', created.data.record.item);
ok('render escapes markup', !esc('<img src=x onerror=alert(1)>').includes('<') && esc('"quoted"').includes('&quot;'));
const badCollection = await call('/api/records', { method: 'POST', body: { collection: 'users', doc: { name: 'x' } } });
ok('unknown collection rejected', badCollection.status === 400, `got ${badCollection.status}`);
ok('unknown fields rejected', created.data.record.malicious === undefined);
ok('amount coerced to number', created.data.record.amount === 123.45);
ok('revision advanced', created.data.rev > startRev);

const recordId = created.data.record.id;

const patched = await call(`/api/records/expenses/${recordId}`, { method: 'PATCH', body: { doc: { amount: 200, status: 'Unpaid' } } });
ok('record updated', patched.status === 200 && patched.data.record.amount === 200 && patched.data.record.status === 'Unpaid');

const diff = await call(`/api/state?since=${startRev}`);
ok('diff returns only changed rows', diff.status === 200 && diff.data.full === false && diff.data.collections.expenses.length === 1, JSON.stringify(diff.data.collections));

const badStatus = await call(`/api/records/expenses/${recordId}`, { method: 'PATCH', body: { doc: { status: 'Hacked' } } });
ok('select value validated', badStatus.data.record.status === 'Paid' || badStatus.data.record.status === 'Unpaid');

const removed = await call(`/api/records/expenses/${recordId}`, { method: 'DELETE' });
ok('record deleted', removed.status === 200 && removed.data.rev > 0);

const diffAfterDelete = await call(`/api/state?since=${patched.data.rev}`);
ok('deletion arrives as a tombstone', Array.isArray(diffAfterDelete.data.deleted.expenses) && diffAfterDelete.data.deleted.expenses.includes(recordId));

const evilDelete = await fetch(`${BASE}/api/records/expenses/${recordId}`, {
  method: 'DELETE',
  headers: { Cookie: cookie, Origin: 'https://attacker.example' },
});
ok('cross-origin mutation blocked', evilDelete.status === 403, `got ${evilDelete.status}`);

const traversal = await call('/api/records/expenses/..%2F..%2Fetc', { method: 'DELETE' });
ok('malformed record id rejected', traversal.status === 404 || traversal.status === 400, `got ${traversal.status}`);

const noAuthFile = await fetch(`${BASE}/api/export`);
ok('export requires session', noAuthFile.status === 401, `got ${noAuthFile.status}`);

// SSE: open a stream, mutate, expect a change frame.
const controller = new AbortController();
const sse = await fetch(`${BASE}/api/events?since=${diffAfterDelete.data.rev}`, {
  headers: { Cookie: cookie, Accept: 'text/event-stream' },
  signal: controller.signal,
});
ok('SSE endpoint streams', sse.status === 200 && String(sse.headers.get('content-type')).includes('text/event-stream'));

const reader = sse.body.getReader();
let sseText = '';
const readPromise = (async () => {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    sseText += decoder.decode(value, { stream: true });
    if (sseText.includes('event: change')) break;
  }
})();

await new Promise((resolve) => setTimeout(resolve, 400));
const probe = await call('/api/records', { method: 'POST', body: { collection: 'diary', doc: { date: '2026-11-02', title: 'SSE probe', status: 'Pending', priority: 'Low' } } });
if (probe.status === 200 && probe.data.record) await call(`/api/records/diary/${probe.data.record.id}`, { method: 'DELETE' });
await Promise.race([readPromise, new Promise((resolve) => setTimeout(resolve, 16000))]);
controller.abort();
ok('SSE delivers a change frame', sseText.includes('event: change'), sseText.slice(0, 120).replace(/\n/g, ' | '));

// ---------------------------------------------------------------- drive
const png = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const form = new FormData();
form.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
const uploadRes = await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Cookie: cookie }, body: form });
const uploaded = await uploadRes.json();
ok('bill file uploads to the drive', uploadRes.status === 200 && Boolean(uploaded.file?.id), JSON.stringify(uploaded));
const fileId = uploaded.file?.id;

const download = await fetch(`${BASE}/api/files/${fileId}`, { headers: { Cookie: cookie } });
ok('uploaded file downloads with its real type', download.status === 200 && download.headers.get('content-type') === 'image/png');

const unauthedFile = await fetch(`${BASE}/api/files/${fileId}`);
ok('drive files need a session', unauthedFile.status === 401, `got ${unauthedFile.status}`);

const drive = await call('/api/files');
ok('drive lists stored files', drive.status === 200 && drive.data.files.length >= 1);

const scanNoAi = await call('/api/scan', { method: 'POST', body: { fileId } });
ok('scan explains that no AI tool is connected', scanNoAi.status === 409, `got ${scanNoAi.status}`);

const fakeKey = ['sk', 'test', 'not', 'real'].join('-');
const badUrl = await call('/api/ai/connections', { method: 'POST', body: { provider: 'x', baseUrl: 'http://insecure.test/v1', model: 'm', apiKey: fakeKey } });
ok('AI base URL must be https', badUrl.status === 400, `got ${badUrl.status}`);

const privateUrl = await call('/api/ai/connections', { method: 'POST', body: { provider: 'x', baseUrl: 'https://127.0.0.1/v1', model: 'm', apiKey: fakeKey } });
ok('private AI endpoints are blocked', privateUrl.status === 400, `got ${privateUrl.status}`);

const goodAi = await call('/api/ai/connections', {
  method: 'POST',
  body: { provider: 'Test', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: fakeKey },
});
ok('AI connection is stored', goodAi.status === 200, JSON.stringify(goodAi.data));

const aiList = await call('/api/ai/connections');
ok('AI keys are never returned to the browser', !JSON.stringify(aiList.data).includes(fakeKey));

const scanFails = await call('/api/scan', { method: 'POST', body: { fileId } });
ok('scan surfaces provider failure cleanly', scanFails.status === 502 || scanFails.status === 504, `got ${scanFails.status}`);

const removedFile = await call(`/api/files/${fileId}`, { method: 'DELETE' });
ok('drive file deletes', removedFile.status === 200);

const removedAi = await call(`/api/ai/connections/${goodAi.data.connection.id}`, { method: 'DELETE' });
ok('AI connection deletes', removedAi.status === 200);

// -------------------------------------------------------- email accounts
const weak = await call('/api/auth/signup', { method: 'POST', body: { email: 'weak@example.com', password: 'short' } });
ok('weak password rejected', weak.status === 400, `got ${weak.status}`);

const inviteOut = await call('/api/family/invite', { method: 'POST' });
ok('owner can create an invite code', inviteOut.status === 200 && Boolean(inviteOut.data.code), JSON.stringify(inviteOut.data));

const badCode = await call('/api/auth/signup', {
  method: 'POST',
  body: { email: `badcode${Date.now()}@example.com`, password: 'Passw0rd123', code: 'NOPE0000' },
});
ok('a wrong invite code is rejected', badCode.status === 400, `got ${badCode.status}`);

// No code at all: the account becomes the owner of a brand-new private planner.
const soloEmail = `solo${Date.now()}@example.com`;
const solo = await call('/api/auth/signup', {
  method: 'POST',
  body: { name: 'Solo', email: soloEmail, password: 'Passw0rd123' },
});
ok('signup works without an invite', solo.status === 200 && solo.data.user?.email === soloEmail, JSON.stringify(solo.data));

const soloAccount = await call('/api/auth/account');
ok('a solo account owns its planner', soloAccount.status === 200 && soloAccount.data.role === 'owner', JSON.stringify(soloAccount.data));

const soloState = await call('/api/state?since=0');
ok(
  'a new planner starts empty and cannot see the household book',
  soloState.status === 200 && (soloState.data.collections.payments || []).length === 0,
  `payments=${(soloState.data.collections?.payments || []).length}`,
);

// Return to the original household owner for the remaining checks.
await call('/api/auth/logout', { method: 'POST' });
const backIn = await call('/api/auth/login', { method: 'POST', body: { pin: process.env.FFP_PIN || '135790' } });
ok('owner session restored after the solo signup', backIn.status === 200, JSON.stringify(backIn.data));

const memberEmail = `member${Date.now()}@example.com`;
const signup = await call('/api/auth/signup', {
  method: 'POST',
  body: { name: 'Member', email: memberEmail, password: 'Passw0rd123', code: inviteOut.data.code },
});
ok('email signup signs the member in', signup.status === 200 && signup.data.user?.email === memberEmail, JSON.stringify(signup.data));

const memberRead = await call('/api/state?since=0');
ok('member session reads the household data', memberRead.status === 200 && memberRead.data.collections.payments.length > 0);

const dup = await call('/api/auth/signup', { method: 'POST', body: { email: memberEmail, password: 'Passw0rd123' } });
ok('duplicate email rejected', dup.status === 409, `got ${dup.status}`);

const account = await call('/api/auth/account');
// Roles are now owner / admin / editor / viewer; an invited household member is
// an editor (full record access, but no member management or invites).
ok('account reports the member role', account.status === 200 && account.data.role === 'editor', JSON.stringify(account.data));

// ------------------------------------------------------------ books/spaces
const pSpace = { 'X-Space': 'personal' };
const personalBefore = await call('/api/state?since=0', { headers: pSpace });
ok('personal book starts separate', personalBefore.status === 200 && personalBefore.data.collections.payments.length === 0);

const privateDoc = await call('/api/records', {
  method: 'POST',
  headers: pSpace,
  body: { collection: 'expenses', doc: { item: 'Private coffee', amount: 120, date: '2026-01-05', status: 'Paid', cat: 'Food' } },
});
ok('personal record saves', privateDoc.status === 200, JSON.stringify(privateDoc.data));

const personalAfter = await call('/api/state?since=0', { headers: pSpace });
ok('personal record lives in the personal book', personalAfter.data.collections.expenses.some((e) => e.item === 'Private coffee'));

const familyAfter = await call('/api/state?since=0');
ok('personal record never appears in the family book', !familyAfter.data.collections.expenses.some((e) => e.item === 'Private coffee'));

const crossDelete = await call(`/api/records/expenses/${privateDoc.data.record.id}`, { method: 'DELETE' });
ok('family book cannot delete a personal row', crossDelete.status === 404, `got ${crossDelete.status}`);

const privateForm = new FormData();
privateForm.append('file', new Blob([png], { type: 'image/png' }), 'private.png');
const privateUpload = await fetch(`${BASE}/api/files`, {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Space': 'personal' },
  body: privateForm,
});
const privateFile = await privateUpload.json();
ok('personal file stores in the personal book', privateUpload.status === 200 && Boolean(privateFile.file?.id));
const familyFileOpen = await fetch(`${BASE}/api/files/${privateFile.file.id}`, { headers: { Cookie: cookie } });
ok('another book cannot open a private file', familyFileOpen.status === 404, `got ${familyFileOpen.status}`);

// --------------------------------------------------------------- office book
const officeDoc = await call('/api/records', {
  method: 'POST',
  headers: { 'X-Space': 'office' },
  body: { collection: 'diary', doc: { title: 'Board meeting', date: '2026-02-01', status: 'Pending', priority: 'High' } },
});
ok('office record saves', officeDoc.status === 200, JSON.stringify(officeDoc.data));
const officeState = await call('/api/state?since=0', { headers: { 'X-Space': 'office' } });
ok('office book keeps its own rows', officeState.data.collections.diary.some((d) => d.title === 'Board meeting'));
const familyState = await call('/api/state?since=0');
ok('office rows never reach the family book', !familyState.data.collections.diary.some((d) => d.title === 'Board meeting'));
const personalState = await call('/api/state?since=0', { headers: { 'X-Space': 'personal' } });
ok('office rows never reach a personal book', !personalState.data.collections.diary.some((d) => d.title === 'Board meeting'));

const memberInvite = await call('/api/family/invite', { method: 'POST' });
ok('only the owner can invite', memberInvite.status === 403, `got ${memberInvite.status}`);

const members = await call('/api/family/members');
ok('member list shows roles', members.status === 200 && members.data.members.some((m) => m.role === 'owner'));

const memberSnapshot = await call('/api/admin/snapshot');
ok('a member cannot export a migration snapshot', memberSnapshot.status === 403, `got ${memberSnapshot.status}`);

const officeBlocked = await call('/api/records', {
  method: 'POST',
  headers: { 'X-Space': 'office' },
  body: { collection: 'payments', doc: { payee: 'Not allowed here', amount: 10, status: 'Unpaid' } },
});
ok('office book rejects personal modules', officeBlocked.status === 400, `got ${officeBlocked.status}`);

// Runs after the office check so the limiter does not block it.
let limitedAt = 0;
for (let i = 0; i < 140 && !limitedAt; i += 1) {
  const res = await call('/api/notifications/read', { method: 'POST', body: { ids: [] } });
  if (res.status === 429) limitedAt = i + 1;
}
ok('per-user write limit engages', limitedAt > 0, 'never limited');

const blockedWrite = await call('/api/records', {
  method: 'POST',
  body: { collection: 'payments', doc: { payee: 'Over limit', amount: 1, status: 'Unpaid' } },
});
ok('a limited user cannot write', blockedWrite.status === 429, `got ${blockedWrite.status}`);

// ------------------------------------------------------------------- lock
const lockRes = await call('/api/auth/lock', { method: 'POST' });
ok('lock revokes the session on the server', lockRes.status === 200);
const afterLock = await call('/api/state');
ok('a locked session cannot read data', afterLock.status === 401, `got ${afterLock.status}`);
await call('/api/auth/login', { method: 'POST', body: { pin: process.env.FFP_PIN || '135790' } });

// ------------------------------------------------------- migration snapshot
// Temporary owner-only export route (migration/DATABASE_MIGRATION.md).
const anonSnapshot = await fetch(`${BASE}/api/admin/snapshot`);
ok('a snapshot needs a session', anonSnapshot.status === 401, `got ${anonSnapshot.status}`);

const revBefore = (await call('/api/state?since=0')).data.rev;
const snapRes = await call('/api/admin/snapshot');
const snap = snapRes.data;
ok('the owner can export a snapshot', snapRes.status === 200 && Boolean(snap.tables), String(snapRes.status));
const SNAP_TABLES = [
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
];
ok(
  'the snapshot carries every migratable table',
  SNAP_TABLES.every((t) => Array.isArray(snap.tables[t])),
  Object.keys(snap.tables).join(','),
);
ok(
  'the snapshot omits sessions and abuse counters',
  !('sessions' in snap.tables) && !('auth_fails' in snap.tables) && !('rate_limits' in snap.tables),
  Object.keys(snap.tables).join(','),
);
ok(
  'the snapshot counts match its own rows',
  SNAP_TABLES.every((t) => snap.counts[t] === snap.tables[t].length),
  JSON.stringify(snap.counts),
);
ok(
  'the snapshot holds real accounts and ledger rows',
  snap.counts.users >= 2 && snap.counts.records > 0 && snap.counts.credentials >= 1,
  JSON.stringify(snap.counts),
);
ok(
  'file rows keep the storage key the migration needs',
  snap.tables.files.every((f) => typeof f.key === 'string' && f.key.length > 0),
);
ok(
  'record documents stay JSON strings so encryption survives',
  snap.tables.records.every((r) => typeof r.doc === 'string' && r.doc.trim().startsWith('{')),
);
const revAfter = (await call('/api/state?since=0')).data.rev;
ok('exporting a snapshot writes nothing', revBefore === revAfter, `rev ${revBefore} -> ${revAfter}`);

const hardHeaders = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } });
ok(
  'responses are non-indexable and origin-bound',
  hardHeaders.headers.get('x-robots-tag') === 'noindex, nofollow' &&
    hardHeaders.headers.get('cross-origin-resource-policy') === 'same-origin',
);

const page = await fetch(`${BASE}/`);
const html = await page.text();
ok('SPA is served', page.status === 200 && html.includes('Family Finance Planner'));
ok('security headers present', String(page.headers.get('content-security-policy') || '').includes("default-src 'self'"));
ok('frame embedding denied', page.headers.get('x-frame-options') === 'DENY');

const sw = await fetch(`${BASE}/sw.js`);
ok('service worker served', sw.status === 200 && (sw.headers.get('content-type') || '').includes('javascript'));

const manifest = await fetch(`${BASE}/manifest.json`);
ok('manifest served', manifest.status === 200);

const icon = await fetch(`${BASE}/icon-192.png`);
ok('icons served', icon.status === 200 && (icon.headers.get('content-type') || '').includes('png'));

const logout = await call('/api/auth/logout', { method: 'POST' });
ok('logout clears the session', logout.status === 200);
const afterLogout = await call('/api/state');
ok('session invalid after logout', afterLogout.status === 401, `got ${afterLogout.status}`);

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
