import { COLLECTION_NAMES } from './entities.js';

export function emptyDb() {
  const db = {};
  for (const name of COLLECTION_NAMES) db[name] = [];
  return db;
}

export function applyState(payload) {
  const full = payload.full || !S.rev;
  for (const [collection, rows] of Object.entries(payload.collections || {})) {
    if (!S.db[collection]) S.db[collection] = [];
    if (full) {
      S.db[collection] = rows;
      continue;
    }
    for (const row of rows) {
      const idx = S.db[collection].findIndex((r) => r.id === row.id);
      if (idx >= 0) S.db[collection][idx] = row;
      else S.db[collection].push(row);
    }
  }
  for (const [collection, ids] of Object.entries(payload.deleted || {})) {
    if (!S.db[collection]) continue;
    S.db[collection] = S.db[collection].filter((r) => !ids.includes(r.id));
  }
  if (payload.settings) S.settings = payload.settings;
  if (payload.notifications) S.notifications = payload.notifications;
  if (typeof payload.unread === 'number') S.unread = payload.unread;
  if (payload.me) S.me = payload.me;
  if (payload.pushPublicKey !== undefined) S.pushPublicKey = payload.pushPublicKey;
  if (typeof payload.rev === 'number') S.rev = payload.rev;
}

export const S = {
  rev: 0,
  db: emptyDb(),
  settings: { mobile: '', alertTime: '06:00', channel: 'Push + in-app', household: '' },
  notifications: [],
  unread: 0,
  me: { name: '' },
  pushPublicKey: null,
  pushEnabled: false,
  demo: null,
  tab: 'dashboard',
  q: {},
  page: {},
  filter: {},
  sort: {},
  alertsOpen: false,
  bellOpen: false,
  search: { name: '', phone: '' },
  sync: 'connecting',
  knownNotifications: new Set(),
  bootedAt: 0,
  error: '',
  busy: false,
  space: 'family',
  theme: 'light',
  lockMinutes: 5,
  locked: false,
  // Profiles and their roles come from the server on every load; the client only
  // mirrors them so the switcher can render, never to decide access.
  profiles: [],
  profile: null,
  profileId: '',
  role: 'viewer',
  inbox: [],
  inboxFilter: '',
  audit: [],
  profileMembers: [],
  drawer: false,
  version: '2.1.0',
  update: null,
  release: null,
};
