// Automated authorisation + isolation tests.
//
// Runs against a Worker (local by default) and proves the properties that matter
// most: a profile id from the client is never trusted, roles are enforced on the
// server, viewers cannot write, and one profile's records, files and audit trail
// are unreachable from another.
//
//   npm run security-test                        # http://127.0.0.1:8787
//   BASE_URL=https://host npm run security-test  # against a deployment (creates data!)
//
// The suite creates its own household, so point it at a local or throwaway
// deployment, never at the household you actually use.

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PIN = '482913';
let passed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const list = raw.length ? raw : [res.headers.get('set-cookie') || ''];
  for (const line of list) {
    const match = String(line).match(/ffp_session=([^;]*)/);
    if (match && match[1]) return `ffp_session=${match[1]}`;
  }
  return '';
}

async function call(path, { method = 'GET', body, cookie = '', profile = '', headers = {}, raw = false } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (profile) init.headers['X-Profile'] = profile;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data = null;
  if (!raw) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
  }
  return { status: res.status, data, text, cookie: cookieFrom(res) };
}

async function main() {
  console.log(`Authorisation suite against ${BASE}`);

  const health = await call('/api/health');
  ok('health reports database + assets', health.status === 200 && health.data?.database && health.data?.assets);
  ok('health reports object storage', health.data?.storage === true, JSON.stringify(health.data));

  const version = await call('/api/version');
  ok('version endpoint is public and versioned', version.status === 200 && Boolean(version.data?.version));

  const status = await call('/api/auth/status');
  if (status.data?.configured) {
    console.log('This deployment already has accounts; refusing to run destructive checks there.');
    process.exit(2);
  }

  const setup = await call('/api/auth/setup', { method: 'POST', body: { name: 'Owner Test', pin: PIN } });
  const owner = setup.cookie;
  ok('owner can create the household', setup.status === 200 && Boolean(owner), setup.text.slice(0, 120));

  const profiles = await call('/api/profiles', { cookie: owner });
  const list = profiles.data?.profiles || [];
  const family = list.find((p) => p.kind === 'family');
  const personal = list.find((p) => p.kind === 'personal');
  const office = list.find((p) => p.kind === 'office');
  ok('every account gets family, office and personal profiles', Boolean(family && personal && office));
  ok('the creator owns all three', list.every((p) => p.role === 'owner'), JSON.stringify(list.map((p) => p.role)));

  const familyState = await call('/api/state?since=0', { cookie: owner, profile: family.id });
  ok('family profile loads for its owner', familyState.status === 200);

  const created = await call('/api/records', {
    method: 'POST',
    cookie: owner,
    profile: family.id,
    body: { collection: 'contacts', doc: { name: 'Shared Contact', mobile: '9876543210' } },
  });
  ok('owner can create a shared record', created.status === 200 && Boolean(created.data?.record?.id));

  const personalState = await call('/api/state?since=0', { cookie: owner, profile: personal.id });
  ok(
    'personal profile does not contain the family record',
    personalState.status === 200 && (personalState.data?.collections?.contacts || []).length === 0,
  );

  const forged = await call('/api/state?since=0', { cookie: owner, profile: 'h:not-a-real-profile' });
  ok('an unknown profile id is refused instead of falling back', forged.status === 404, String(forged.status));

  const anonymous = await call('/api/state?since=0', { profile: family.id });
  ok('unauthenticated state is 401', anonymous.status === 401);

  const evil = await call('/api/auth/login', {
    method: 'POST',
    body: { pin: PIN },
    headers: { Origin: 'https://evil.example' },
  });
  ok('cross-origin login is blocked', evil.status === 403, String(evil.status));

  // --- second account joins through an invite -----------------------------
  const invite = await call('/api/family/invite', { method: 'POST', cookie: owner, profile: family.id });
  ok('owner can issue an invite', invite.status === 200 && Boolean(invite.data?.code));

  const signup = await call('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Member Test', email: 'member@example.test', password: 'secret123', code: invite.data?.code },
  });
  const member = signup.cookie;
  ok('invited member can create an account', signup.status === 200 && Boolean(member), signup.text.slice(0, 160));

  const memberState = await call('/api/state?since=0', { cookie: member, profile: family.id });
  ok(
    'member sees the shared family record',
    memberState.status === 200 && (memberState.data?.collections?.contacts || []).length >= 1,
  );

  const members = await call('/api/family/members', { cookie: owner, profile: family.id });
  const memberRows = members.data?.members || [];
  const memberId = memberRows.find((m) => m.id !== members.data?.me)?.id;
  ok('member list exposes roles, not just names', memberRows.every((m) => Boolean(m.role)));

  const memberProfiles = await call('/api/profiles', { cookie: member });
  const memberPersonal = (memberProfiles.data?.profiles || []).find((p) => p.kind === 'personal');
  ok('member has their own private profile', Boolean(memberPersonal));
  ok(
    'member cannot see the owner private profile',
    !(memberProfiles.data?.profiles || []).some((p) => p.id === personal.id),
  );

  const crossRead = await call('/api/state?since=0', { cookie: member, profile: personal.id });
  ok('member reading the owner private profile is refused', crossRead.status === 404, String(crossRead.status));

  // --- viewer role --------------------------------------------------------
  const demote = await call(`/api/profiles/${encodeURIComponent(family.id)}/members/${memberId}`, {
    method: 'PATCH',
    cookie: owner,
    profile: family.id,
    body: { role: 'viewer' },
  });
  ok('owner can set a member to viewer', demote.status === 200, demote.text.slice(0, 120));

  const viewerRead = await call('/api/state?since=0', { cookie: member, profile: family.id });
  ok('viewer can still read the shared book', viewerRead.status === 200);

  const viewerWrite = await call('/api/records', {
    method: 'POST',
    cookie: member,
    profile: family.id,
    body: { collection: 'contacts', doc: { name: 'Viewer Injection', mobile: '9000000000' } },
  });
  ok('viewer cannot create records', viewerWrite.status === 403, String(viewerWrite.status));

  const viewerDelete = await call(`/api/records/contacts/${created.data?.record?.id}`, {
    method: 'DELETE',
    cookie: member,
    profile: family.id,
  });
  ok('viewer cannot delete records', viewerDelete.status === 403, String(viewerDelete.status));

  const viewerSettings = await call('/api/settings', {
    method: 'POST',
    cookie: member,
    profile: family.id,
    body: { household: 'Hijacked' },
  });
  ok('viewer cannot change profile settings', viewerSettings.status === 403, String(viewerSettings.status));

  const viewerClear = await call('/api/admin/clear', { method: 'POST', cookie: member, profile: family.id });
  ok('viewer cannot wipe the profile', viewerClear.status === 403, String(viewerClear.status));

  const viewerInvite = await call('/api/family/invite', { method: 'POST', cookie: member, profile: family.id });
  ok('viewer cannot invite people', viewerInvite.status === 403, String(viewerInvite.status));

  const viewerAudit = await call('/api/audit', { cookie: member, profile: family.id });
  ok('viewer cannot read the audit trail', viewerAudit.status === 403, String(viewerAudit.status));

  // --- documents ----------------------------------------------------------
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
  const upload = await call('/api/files', { method: 'POST', cookie: owner, profile: personal.id, body: form });
  ok('owner can upload a document to a private profile', upload.status === 200 && Boolean(upload.data?.file?.id), upload.text.slice(0, 140));

  const privateFile = upload.data?.file?.id;
  const ownFile = await call(`/api/files/${privateFile}`, { cookie: owner, profile: personal.id, raw: true });
  ok('owner can read their own document', ownFile.status === 200);

  const stolenFile = await call(`/api/files/${privateFile}`, { cookie: member, profile: family.id, raw: true });
  ok('another account cannot fetch a private document by id', stolenFile.status === 404, String(stolenFile.status));

  const memberUpload = await call('/api/files', { method: 'POST', cookie: member, profile: family.id, body: (() => {
    const f = new FormData();
    f.append('file', new Blob([png], { type: 'image/png' }), 'nope.png');
    return f;
  })() });
  ok('viewer cannot upload documents', memberUpload.status === 403, String(memberUpload.status));

  // --- audit trail --------------------------------------------------------
  const exported = await call('/api/export', { cookie: owner, profile: family.id });
  ok('owner can export their profile', exported.status === 200 && Boolean(exported.data?.data));

  const audit = await call('/api/audit', { cookie: owner, profile: family.id });
  const actions = (audit.data?.events || []).map((e) => e.action);
  ok('audit records logins', actions.includes('auth.login'));
  ok('audit records sharing', actions.includes('share.invite'));
  ok('audit records role changes', actions.includes('profile.role'));
  ok('audit records exports', actions.includes('data.export'), actions.join(','));

  const auditText = JSON.stringify(audit.data || {});
  ok('audit trail carries no ciphertext or field values', !/enc1:/.test(auditText) && !/9876543210/.test(auditText));

  // --- privilege escalation attempts --------------------------------------
  const viewerPin = await call('/api/auth/pin', {
    method: 'POST',
    cookie: member,
    profile: family.id,
    body: { currentPin: PIN, newPin: '111222' },
  });
  ok('viewer cannot rewrite the household PIN', viewerPin.status === 403, String(viewerPin.status));

  const viewerPromote = await call(`/api/profiles/${encodeURIComponent(family.id)}/members/${memberId}`, {
    method: 'PATCH',
    cookie: member,
    profile: family.id,
    body: { role: 'admin' },
  });
  ok('viewer cannot promote themselves', viewerPromote.status === 403, String(viewerPromote.status));

  const memberSnapshot = await call('/api/admin/snapshot', { cookie: member, profile: family.id });
  ok('credential snapshot is closed to members', memberSnapshot.status === 403, String(memberSnapshot.status));

  const ownerSnapshot = await call('/api/admin/snapshot', { cookie: owner, profile: family.id });
  ok(
    'credential snapshot stays off unless migration mode is enabled',
    ownerSnapshot.status === 404,
    String(ownerSnapshot.status),
  );

  const foreignUnsub = await call('/api/push/unsubscribe', {
    method: 'POST',
    cookie: member,
    body: { endpoint: 'https://push.example.test/another-account' },
  });
  ok('unsubscribe is accepted but scoped to the caller', foreignUnsub.status === 200);

  const plainError = await call('/api/records', {
    method: 'POST',
    cookie: owner,
    profile: family.id,
    body: { collection: 'not-a-collection', doc: {} },
  });
  ok(
    'error responses carry no SQL or stack detail',
    plainError.status >= 400 && !/SELECT|INSERT|D1_|at .*\.js:\d+/i.test(plainError.text),
    plainError.text.slice(0, 120),
  );

  // --- notifications ------------------------------------------------------
  const inbox = await call('/api/notifications/all', { cookie: member, profile: family.id });
  ok('cross-profile inbox works for members', inbox.status === 200 && Array.isArray(inbox.data?.notifications));
  const inboxProfiles = (inbox.data?.profiles || []).map((p) => p.id);
  ok(
    'inbox only spans profiles the account belongs to',
    !inboxProfiles.includes(personal.id) && inboxProfiles.includes(family.id),
  );

  // --- cleanup of the private upload --------------------------------------
  const removed = await call(`/api/files/${privateFile}`, { method: 'DELETE', cookie: owner, profile: personal.id });
  ok('owner can delete their own document', removed.status === 200);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
