// Profiles, roles, per-profile membership and the security audit trail.
//
// A profile id IS the storage namespace used by records/files/notifications
// (`space` in the older code): 'family' (or 'h:<owner id>') for a household,
// 'u:<user id>' for a private book and 'o:<user id>' for the office book.
// Reusing the space key means every existing query stays scoped exactly as
// before, while access control is now derived from profile_members instead of
// from the client-supplied header alone.

import { HttpError } from './errors.js';

export const PROFILE_KINDS = ['family', 'office', 'personal'];

export const ROLE_LABEL = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

// view   - read records, files, notifications
// create - add records
// update - change records and mark notifications read
// delete - remove records and files
// export - download data / create backups
// manage - settings, members, invites, profile administration
// share  - invite people into this profile
//
// Editor deliberately keeps delete: accounts created before roles existed as a
// plain household "member" could already delete rows, so the migration maps them
// to editor instead of silently taking a capability away.
const PERMISSIONS = {
  owner: ['view', 'create', 'update', 'delete', 'export', 'manage', 'share'],
  admin: ['view', 'create', 'update', 'delete', 'export', 'manage'],
  editor: ['view', 'create', 'update', 'delete', 'export'],
  viewer: ['view', 'export'],
};

export function roleAllows(role, permission) {
  const list = PERMISSIONS[role];
  return Boolean(list && list.includes(permission));
}

export function isRole(value) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, String(value));
}

/** The storage namespace for one of a user's own profiles. */
export function spaceForProfile(kind, userId, household) {
  if (kind === 'personal') return `u:${userId}`;
  if (kind === 'office') return `o:${userId}`;
  return household || 'family';
}

export async function profileById(env, id) {
  if (!id) return null;
  return env.DB.prepare(`SELECT id, kind, name, owner_id, created_at FROM profiles WHERE id = ?`)
    .bind(String(id).slice(0, 80))
    .first();
}

export async function memberRow(env, profileId, userId) {
  return env.DB.prepare(
    `SELECT profile_id, user_id, role, created_at FROM profile_members WHERE profile_id = ? AND user_id = ?`,
  )
    .bind(String(profileId), String(userId))
    .first();
}

export async function createProfile(env, { id, kind, name, ownerId }) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO profiles (id, kind, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(String(id).slice(0, 80), kind, String(name || 'Profile').slice(0, 80), ownerId, Date.now()),
    env.DB.prepare(
      `INSERT INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
       ON CONFLICT(profile_id, user_id) DO UPDATE SET role = 'owner'`,
    ).bind(String(id).slice(0, 80), ownerId, Date.now()),
  ]);
}

/**
 * Every account owns a personal and an office profile, and belongs to the
 * family profile of its household. Idempotent: safe to run on every boot and
 * after any user is created.
 */
export async function ensureProfiles(env) {
  const users = (await env.DB.prepare(
    `SELECT id, name, role, household, created_at FROM users ORDER BY created_at`,
  ).all()).results || [];
  if (!users.length) return;

  const settings = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'settings'`).first();
  let householdName = '';
  try {
    const parsed = settings ? JSON.parse(settings.v) : null;
    householdName = (parsed && parsed.household) || '';
  } catch {
    householdName = '';
  }

  const owners = new Map();
  for (const user of users) {
    const household = user.household || 'family';
    if (!owners.has(household) || user.role === 'owner') owners.set(household, user);
  }

  const statements = [];
  const seenHouseholds = new Set();
  for (const user of users) {
    const kindRole = user.role === 'owner' ? 'owner' : 'editor';
    for (const kind of ['personal', 'office']) {
      const id = spaceForProfile(kind, user.id);
      statements.push(
        env.DB.prepare(
          `INSERT INTO profiles (id, kind, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          id,
          kind,
          kind === 'personal' ? `${user.name} · Personal` : `${user.name} · Office`,
          user.id,
          user.created_at || Date.now(),
        ),
      );
      statements.push(
        env.DB.prepare(
          `INSERT INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
           ON CONFLICT(profile_id, user_id) DO UPDATE SET role = 'owner'`,
        ).bind(id, user.id, Date.now()),
      );
    }

    const household = user.household || 'family';
    if (!seenHouseholds.has(household)) {
      seenHouseholds.add(household);
      const owner = owners.get(household) || user;
      const label =
        household === 'family'
          ? householdName || 'Family'
          : `${(householdName || 'Household')} · ${owner.name}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO profiles (id, kind, name, owner_id, created_at) VALUES (?, 'family', ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        ).bind(household, label, owner.id, owner.created_at || Date.now()),
      );
      // Keep the household owner as the profile owner even if users.role drifted.
      statements.push(
        env.DB.prepare(
          `INSERT INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
           ON CONFLICT(profile_id, user_id) DO UPDATE SET role = CASE
             WHEN profile_members.role = 'owner' AND profile_members.user_id != excluded.user_id THEN profile_members.role
             ELSE excluded.role END`,
        ).bind(household, owner.id, Date.now()),
      );
    }
    statements.push(
      // A member without an explicit row gets the closest equivalent to the old
      // 'member' role (full record access) so nothing they could do yesterday is
      // lost; the owner can downgrade them to viewer in Settings.
      env.DB.prepare(
        `INSERT INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, user_id) DO NOTHING`,
      ).bind(household, user.id, kindRole, Date.now()),
    );
  }

  // D1 caps a batch at 100 statements; chunk to stay well inside it.
  for (let i = 0; i < statements.length; i += 40) {
    await env.DB.batch(statements.slice(i, i + 40));
  }
}

/**
 * Resolve the profile named by the request for this session, enforcing that the
 * caller really is a member. Returns the profile plus the caller's role.
 */
export async function resolveProfile(env, session, requested, permission = 'view') {
  // Never fall back to the shared literal 'family': a session without a
  // household belongs to its own account, so its own book is the only safe
  // default. Without this, two accounts with a missing household id resolved to
  // the same profile and saw each other's rows.
  const fallback = session.household || (session.userId ? `h:${session.userId}` : '');
  const wanted = String(requested || '').slice(0, 80) || fallback;
  const row = await profileById(env, wanted);
  if (!row) throw new HttpError(404, 'That profile does not exist');

  let member = await memberRow(env, row.id, session.userId);
  if (!member && row.owner_id === session.userId) {
    // Self-healing: an owner always keeps access to a profile they created.
    await env.DB.prepare(
      `INSERT INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
       ON CONFLICT(profile_id, user_id) DO UPDATE SET role = 'owner'`,
    ).bind(row.id, session.userId, Date.now()).run();
    member = { profile_id: row.id, user_id: session.userId, role: 'owner' };
  }
  if (!member) throw new HttpError(404, 'That profile does not exist');

  const role = isRole(member.role) ? member.role : 'viewer';
  if (permission && !roleAllows(role, permission)) {
    throw new HttpError(403, `Your ${ROLE_LABEL[role] || role} role cannot ${verbFor(permission)} in this profile`);
  }
  return { ...row, role };
}

function verbFor(permission) {
  return (
    {
      view: 'view data',
      create: 'add records',
      update: 'edit records',
      delete: 'delete records',
      export: 'export data',
      manage: 'manage this profile',
      share: 'share this profile',
    }[permission] || permission
  );
}

export async function listProfiles(env, userId) {
  const rows = (await env.DB.prepare(
    `SELECT p.id, p.kind, p.name, p.owner_id, p.created_at, m.role
       FROM profile_members m JOIN profiles p ON p.id = m.profile_id
      WHERE m.user_id = ?
      ORDER BY CASE p.kind WHEN 'family' THEN 0 WHEN 'office' THEN 1 ELSE 2 END, p.created_at`,
  )
    .bind(userId)
    .all()).results || [];

  const ids = rows.map((r) => r.id);
  let counts = {};
  if (ids.length) {
    const holes = ids.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `SELECT space, COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND space IN (${holes}) GROUP BY space`,
    )
      .bind(...ids)
      .all();
    counts = Object.fromEntries((res.results || []).map((r) => [r.space, r.n]));
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    role: isRole(r.role) ? r.role : 'viewer',
    ownerId: r.owner_id,
    unread: counts[r.id] || 0,
  }));
}

export async function profileMembers(env, profileId) {
  const res = await env.DB.prepare(
    `SELECT m.user_id AS id, m.role, m.created_at, u.name, c.email
       FROM profile_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN credentials c ON c.user_id = u.id
      WHERE m.profile_id = ? ORDER BY m.created_at`,
  )
    .bind(profileId)
    .all();
  return res.results || [];
}

/** Owner/admin change another member's role. Owners cannot demote the last owner. */
export async function setMemberRole(env, profileId, actorId, targetId, role) {
  if (!isRole(role)) throw new HttpError(400, 'Unknown role');
  const target = await memberRow(env, profileId, targetId);
  if (!target) throw new HttpError(404, 'That person is not a member of this profile');
  const profile = await profileById(env, profileId);
  if (!profile) throw new HttpError(404, 'That profile does not exist');
  if (role !== 'owner' && profile.owner_id === targetId) {
    throw new HttpError(400, 'The profile owner cannot be demoted');
  }
  if (targetId === actorId && role !== 'owner') {
    throw new HttpError(400, 'You cannot change your own role');
  }
  await env.DB.prepare(`UPDATE profile_members SET role = ? WHERE profile_id = ? AND user_id = ?`)
    .bind(role, profileId, targetId)
    .run();
  // Keep the legacy household flag in step so member lists stay truthful.
  if (profileId === (await householdOf(env, targetId))) {
    await env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`)
      .bind(role === 'owner' ? 'owner' : 'member', targetId)
      .run();
  }
  return { userId: targetId, role };
}

async function householdOf(env, userId) {
  const row = await env.DB.prepare(`SELECT household FROM users WHERE id = ?`).bind(userId).first();
  return row ? row.household || 'family' : null;
}

/** Share an existing profile with a user id (used when an invite is redeemed). */
export async function addProfileMember(env, profileId, userId, role = 'editor') {
  await env.DB.prepare(
    `INSERT INTO profile_members (profile_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(profileId, userId, isRole(role) ? role : 'editor', Date.now())
    .run();
}

export async function dropProfileMember(env, profileId, userId) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM profile_members WHERE profile_id = ? AND user_id = ?`).bind(profileId, userId),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
  ]);
}

/* ----------------------------------------------------------------- audit */

const AUDIT_ACTIONS = new Set([
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.lock',
  'auth.password',
  'auth.recovery',
  'auth.recovery_code',
  'auth.2fa',
  'auth.otp',
  'auth.telegram',
  'profile.switch',
  'profile.create',
  'profile.role',
  'share.invite',
  'share.revoke',
  'data.export',
  'data.restore',
  'data.clear',
  'data.delete',
  'settings.update',
  'backup.create',
  'backup.restore',
  'record.delete',
]);

/**
 * Append to the security audit trail. Only action names, opaque id targets and
 * short technical detail are stored: never record values, tokens or keys.
 */
export async function audit(env, event) {
  const action = String(event.action || '').slice(0, 40);
  if (!AUDIT_ACTIONS.has(action)) return;
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (ts, actor, profile_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        Date.now(),
        event.actor ? String(event.actor).slice(0, 80) : null,
        event.profileId ? String(event.profileId).slice(0, 80) : null,
        action,
        event.target ? String(event.target).slice(0, 120) : null,
        event.detail ? String(event.detail).slice(0, 240) : null,
      )
      .run();
  } catch {
    /* auditing must never break the request it describes */
  }
}

export async function listAudit(env, profileId, limit = 60) {
  const res = await env.DB.prepare(
    `SELECT a.id, a.ts, a.actor, a.profile_id, a.action, a.target, a.detail, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor
      WHERE a.profile_id IS NULL OR a.profile_id = ?
      ORDER BY a.ts DESC LIMIT ?`,
  )
    .bind(profileId, Math.min(Math.max(Number(limit) || 60, 1), 200))
    .all();
  return res.results || [];
}

export async function pruneAudit(env, days = 90) {
  await env.DB.prepare(`DELETE FROM audit_log WHERE ts < ?`).bind(Date.now() - days * 86400000).run();
}
