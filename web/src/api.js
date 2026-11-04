// Thin API client. All requests are same-origin, cookies carry the session.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let space = 'family';
let profile = '';

/** 'family' shares the household book; 'personal' is private to the signed-in account. */
export function setSpace(value) {
  space = value === 'personal' || value === 'office' ? value : 'family';
}

/** The profile id is the real selector; the worker re-checks membership on every call. */
export function setProfile(id) {
  profile = String(id || '');
}

export function currentSpace() {
  return profile || space;
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'X-Space': space,
      ...(profile ? { 'X-Profile': profile } : {}),
      ...headers,
    },
  };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = request;

export const getState = (since = 0) => request(`/api/state?since=${encodeURIComponent(since)}`);
export const authStatus = () => request('/api/auth/status');
export const login = (payload) => request('/api/auth/login', { method: 'POST', body: payload });
export const signup = (name, email, password, code) => request('/api/auth/signup', { method: 'POST', body: { name, email, password, code } });
export const resetPassword = (email, pin, password) => request('/api/auth/reset', { method: 'POST', body: { email, pin, password } });
export const lockSession = () => request('/api/auth/lock', { method: 'POST' });
export const setPassword = (current, next, email) => request('/api/auth/password', { method: 'POST', body: { current, next, email } });
export const account = () => request('/api/auth/account');
export const familyMembers = () => request('/api/family/members');
export const createInvite = () => request('/api/family/invite', { method: 'POST' });
export const removeMember = (id) => request(`/api/family/members/${id}`, { method: 'DELETE' });

export const files = () => request('/api/files');
export const uploadFile = (formData) => request('/api/files', { method: 'POST', body: formData });
export const deleteFile = (id) => request(`/api/files/${id}`, { method: 'DELETE' });
export const scanFile = (fileId) => request('/api/scan', { method: 'POST', body: { fileId } });

export const aiConnections = () => request('/api/ai/connections');
export const addAiConnection = (doc) => request('/api/ai/connections', { method: 'POST', body: doc });
export const deleteAiConnection = (id) => request(`/api/ai/connections/${id}`, { method: 'DELETE' });
export const testAiConnection = (id) => request(`/api/ai/connections/${id}/test`, { method: 'POST' });
export const setup = (name, pin) => request('/api/auth/setup', { method: 'POST', body: { name, pin } });
export const logout = () => request('/api/auth/logout', { method: 'POST' });
export const changePin = (currentPin, newPin) => request('/api/auth/pin', { method: 'POST', body: { currentPin, newPin } });
export const sessions = () => request('/api/auth/sessions');
export const revokeAllSessions = () => request('/api/auth/sessions/revoke', { method: 'POST' });

export const createRecord = (collection, doc) => request('/api/records', { method: 'POST', body: { collection, doc } });
export const updateRecord = (collection, id, doc) => request(`/api/records/${collection}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { doc } });
export const deleteRecord = (collection, id) => request(`/api/records/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const bulkImport = (collection, docs, restore = false) =>
  request('/api/records/bulk', { method: 'POST', body: { collection, docs, restore } });

export const profiles = () => request('/api/profiles');
export const switchProfile = (id) => request('/api/profiles/switch', { method: 'POST', body: { profile: id } });
export const profileMembers = (id) => request(`/api/profiles/${encodeURIComponent(id)}/members`);
export const setMemberRole = (id, userId, role) =>
  request(`/api/profiles/${encodeURIComponent(id)}/members/${userId}`, { method: 'PATCH', body: { role } });
export const auditLog = (limit = 60) => request(`/api/audit?limit=${encodeURIComponent(limit)}`);
export const inbox = () => request('/api/notifications/all');
export const version = () => request('/api/version');
export const backupEvent = (action, target, bytes) =>
  request('/api/backup', { method: 'POST', body: { action, target, bytes } });
export const exportProfile = (id) => request('/api/export', { headers: { 'X-Profile': id } });

export const markRead = (ids) => request('/api/notifications/read', { method: 'POST', body: { ids } });
export const saveSettings = (settings) => request('/api/settings', { method: 'POST', body: settings });
export const activity = () => request('/api/activity');
export const resetData = () => request('/api/admin/reset', { method: 'POST' });
export const clearData = () => request('/api/admin/clear', { method: 'POST' });
export const sampleData = () => request('/api/admin/sample', { method: 'POST' });

export const pushKey = () => request('/api/push/key');
export const subscribePush = (subscription) => request('/api/push/subscribe', { method: 'POST', body: subscription });
export const unsubscribePush = (endpoint) => request('/api/push/unsubscribe', { method: 'POST', body: { endpoint } });
export const testPush = () => request('/api/push/test', { method: 'POST' });

/**
 * Live updates. The Worker holds the request open until the collection revision
 * changes, then closes; we pull the diff and reconnect with the new revision.
 */
export function connectEvents({ since, onRev, onStatus }) {
  let source = null;
  let closed = false;
  let retry = 0;
  let timer = null;

  const open = () => {
    if (closed) return;
    onStatus('connecting');
    source = new EventSource(
      `/api/events?since=${encodeURIComponent(since)}&profile=${encodeURIComponent(profile || space)}`,
    );
    source.addEventListener('open', () => {
      retry = 0;
      onStatus('live');
    });
    source.addEventListener('change', (event) => {
      let rev = since;
      try {
        rev = JSON.parse(event.data).rev || since;
      } catch {
        /* ignore malformed frame */
      }
      source.close();
      onStatus('live');
      onRev(rev);
    });
    source.addEventListener('error', () => {
      onStatus('offline');
      source.close();
      source = null;
      retry = Math.min(retry + 1, 6);
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(open, Math.min(15000, 1500 * retry));
    });
  };

  open();
  return {
    updateRev(rev) {
      since = rev;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      if (source) source.close();
    },
  };
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
