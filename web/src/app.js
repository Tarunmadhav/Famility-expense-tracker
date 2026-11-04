// App shell: auth, realtime sync, notifications, forms and event wiring.

import { COLLECTIONS } from './entities.js';
import { S, applyState, emptyDb } from './state.js';
import * as api from './api.js';
import * as views from './views.js';
import * as shell from './shell.js';
import * as dashboard from './dashboard.js';
import { createBackupFile, readBackupFile, restorePayload } from './backup.js';
import {
  alertDigestText,
  buildICS,
  calendarFileName,
  csvOf,
  csvTemplate,
  docsFromCsv,
  download,
  googleContactsToDocs,
  notificationMessage,
  recordMessage,
  smsLink,
  whatsappLink,
} from './exporters.js';
import { esc } from './format.js';

S.view = 'loading';
S.activity = [];
S.sessions = [];
S.currentSession = '';
S.files = [];
S.filesTotal = 0;
S.storage = true;
S.aiConnections = [];
S.account = {};
S.members = [];
S.invite = null;
S.authView = 'login';
S.authMode = 'login';
let events = null;
let pollTimer = null;
let deferredPrompt = null;
let lastActive = Date.now();

const THEME_KEY = 'ffp_theme';
const LOCK_KEY = 'ffp_lock_minutes';
const SPACE_KEY = 'ffp_space';
const PROFILE_KEY = 'ffp_profile';

/** Theme is a per-device preference; the attribute drives every CSS token. */
function applyTheme(theme, persist = true) {
  S.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', S.theme);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, S.theme);
    } catch {
      /* private mode */
    }
  }
}

function initPreferences() {
  let stored = null;
  let storedLock = null;
  let storedSpace = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
    storedLock = localStorage.getItem(LOCK_KEY);
    storedSpace = localStorage.getItem(SPACE_KEY);
  } catch {
    /* storage blocked */
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(stored || (prefersDark ? 'dark' : 'light'), false);
  S.lockMinutes = storedLock === null ? 5 : Number(storedLock) || 0;
  S.space = storedSpace === 'personal' ? 'personal' : 'family';
  api.setSpace(S.space);
  let storedProfile = '';
  try {
    storedProfile = localStorage.getItem(PROFILE_KEY) || '';
  } catch {
    storedProfile = '';
  }
  if (storedProfile) api.setProfile(storedProfile);
}

initPreferences();

/* --------------------------------------------------------------- helpers */

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function app() {
  return document.getElementById('app');
}

function setView(view, message = '') {
  S.view = view;
  S.error = message;
  render();
}

/* ---------------------------------------------------------------- render */

function render() {
  closeBellOnOutside();
  if (S.locked) {
    app().innerHTML = views.lockHtml(S.lockError || '');
    const input = document.getElementById('lockpin');
    if (input) input.focus();
    return;
  }
  if (S.view === 'setup') {
    app().innerHTML = views.authShell(views.setupFormHtml(S.error));
    const input = document.getElementById('household');
    if (input) input.focus();
    return;
  }
  if (S.view === 'login' || S.view === 'loading') {
    if (S.view === 'loading') {
      app().innerHTML = '<div class="auth"><div class="authcard"><div class="brand"><span class="logo">₹</span><div><h1>Family Finance Planner</h1><div class="mut">Connecting…</div></div></div></div></div>';
      return;
    }
    let formHtml;
    if (S.authView === 'forgot') formHtml = views.forgotFormHtml(S.error);
    else if (S.authView === 'signup') formHtml = views.signupFormHtml(S.error);
    else formHtml = views.loginFormHtml(S.error);
    app().innerHTML = views.authShell(formHtml);
    const first = document.getElementById(S.authView === 'signup' ? 'su_name' : S.authView === 'forgot' ? 'fp_email' : 'email') || document.getElementById('pin');
    if (first) first.focus();
    return;
  }

  let content;
  if (S.tab === 'dashboard') content = dashboard.dashboardHtml();
  else if (S.tab === 'reports') content = dashboard.reportsHtml();
  else if (S.tab === 'notifications') content = views.inboxView();
  else if (S.tab === 'family') content = views.familyView();
  else if (S.tab === 'subscriptions') content = views.subscriptionsView();
  else if (S.tab === 'budget') content = views.budgetView();
  else if (S.tab === 'settings') content = views.settingsView();
  else if (COLLECTIONS[S.tab]) content = views.tableView(S.tab);
  else content = views.tableView('expenses');

  const active = document.activeElement;
  const focusKey = active && active.getAttribute ? active.getAttribute('data-q') || active.id : '';
  const caret = active && active.selectionStart ? active.selectionStart : 0;

  app().innerHTML = `<div class="shell" data-kind="${shell.currentKind()}">
      ${shell.sidebarHtml()}
      <div class="workarea">
        ${shell.topbarHtml(shell.titleFor(S.tab), views.headerSub())}
        <main id="main" class="content">${content}</main>
      </div>
    </div>
    ${shell.tabbarHtml()}
    ${S.bellOpen ? views.notificationsPanelHtml() : ''}
    ${S.update ? views.updateBannerHtml() : ''}`;

  if (focusKey) {
    const el = document.querySelector(`[data-q="${focusKey}"]`) || document.getElementById(focusKey);
    if (el && el.focus) {
      el.focus();
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* not a text field */
      }
    }
  }
}

function closeBellOnOutside() {
  /* panel is re-rendered from state; nothing to clean up here */
}

function renderSyncBadge() {
  const el = document.getElementById('sync');
  if (!el) return;
  el.className = `sync ${S.sync}`;
  el.innerHTML = `<i></i>${S.sync === 'live' ? 'Live' : 'Sync'}`;
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  registerServiceWorker();
  try {
    const status = await api.authStatus();
    if (!status.configured) return setView('setup');
    if (!status.user) return setView('login');
    S.me = status.user;
    S.pushPublicKey = status.push ? S.pushPublicKey : null;
    await checkForUpdate();
    await loadApp();
    await applyDeepLinkProfile();
  } catch (err) {
    setView('login', `Cannot reach the planner API: ${err.message}`);
  }
}

async function loadApp() {
  const payload = await api.getState(0);
  S.locked = false;
  S.lockError = '';
  S.db = emptyDb();
  S.rev = 0;
  applyState(payload);
  S.settings = payload.settings || S.settings;
  // The server decides which profiles exist and what role this account holds in
  // each; the client only remembers the id it last viewed.
  S.profiles = payload.profiles || S.profiles || [];
  S.profile = payload.profile || null;
  if (S.profile) {
    S.profileId = S.profile.id;
    S.role = S.profile.role;
    S.space = S.profile.kind;
    api.setProfile(S.profile.id);
  }
  S.version = payload.version || S.version;
  S.knownNotifications = new Set((payload.notifications || []).map((n) => n.id));
  S.bootedAt = Date.now();
  S.view = 'app';
  S.sync = 'connecting';
  render();
  startRealtime();
  startPolling();
  await detectPush();
  await checkPendingNotifications(true);
  announceProfile();
  ctxSafeLoadInbox();
}

/** Tell the service worker which profile is open, for discreet push text. */
function announceProfile() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => {
      const target = reg.active || navigator.serviceWorker.controller;
      if (target) target.postMessage({ type: 'profile', id: S.profileId });
    })
    .catch(() => {});
}

/** `/?profile=<id>` opens a notification in its own profile, after the server
 *  confirms this account is a member of it. */
async function applyDeepLinkProfile() {
  let wanted = '';
  try {
    wanted = new URLSearchParams(window.location.search).get('profile') || '';
  } catch {
    wanted = '';
  }
  if (!wanted || wanted === S.profileId) return;
  if (!(S.profiles || []).some((p) => p.id === wanted)) return;
  await switchProfile(wanted);
  try {
    window.history.replaceState({}, '', window.location.pathname);
  } catch {
    /* history is decorative here */
  }
}

function ctxSafeLoadInbox() {
  loadInbox().catch(() => {});
}

/** Cross-profile inbox: every profile this account can read, grouped by profile. */
async function loadInbox() {
  const out = await api.inbox();
  S.inbox = out.notifications || [];
  if (out.profiles) {
    S.profiles = (S.profiles || []).map((p) => {
      const fresh = out.profiles.find((f) => f.id === p.id);
      return fresh ? { ...p, unread: fresh.unread } : p;
    });
  }
  return out;
}

function startRealtime() {
  if (events) events.close();
  events = api.connectEvents({
    since: S.rev,
    onRev: async () => {
      events = null;
      try {
        await refresh();
      } finally {
        startRealtime();
      }
    },
    onStatus: (status) => {
      S.sync = status === 'live' ? 'live' : 'connecting';
      renderSyncBadge();
    },
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      await refresh();
    } catch (err) {
      // A locked/revoked session from another tab shows the lock screen here too.
      if (err && err.status === 401 && S.view === 'app' && !S.locked) lockNow();
    }
  }, 30000);
}

async function refresh() {
  const payload = await api.getState(S.rev);
  const before = S.rev;
  applyState(payload);
  if (S.tab === 'settings') await loadSettingsData();
  render();
  if (S.rev !== before) await checkPendingNotifications(false);
}

async function checkPendingNotifications(initial) {
  const fresh = (S.notifications || []).filter((n) => !S.knownNotifications.has(n.id));
  fresh.forEach((n) => S.knownNotifications.add(n.id));
  if (initial || !fresh.length) return;
  fresh.slice(0, 3).forEach((n) => showSystemNotification(n));
  render();
}

/* -------------------------------------------------------- system alerts */

async function showSystemNotification(note) {
  toast(`${note.title}`);
  if (window.AndroidBridge && typeof window.AndroidBridge.notify === 'function') {
    try {
      window.AndroidBridge.notify(String(note.title), String(note.body || ''));
      return;
    } catch {
      /* fall through to web notification */
    }
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(note.title, {
      body: note.body || '',
      tag: note.type || 'planner',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/' },
    });
  } catch {
    try {
      new Notification(note.title, { body: note.body || '', icon: '/icon-192.png' });
    } catch {
      /* notifications unavailable */
    }
  }
}

async function detectPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    S.pushEnabled = Boolean(sub);
  } catch {
    S.pushEnabled = false;
  }
}

async function enableNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    toast('This browser cannot show notifications');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Notification permission was not granted');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const key = await api.pushKey();
    if (!key.publicKey) {
      toast('Push is not configured on the server');
      return;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: api.urlBase64ToUint8Array(key.publicKey),
      });
    }
    await api.subscribePush(sub.toJSON ? sub.toJSON() : sub);
    S.pushEnabled = true;
    toast('Mobile notifications enabled');
  } catch (err) {
    toast(`Could not enable notifications: ${err.message}`);
  }
  render();
}

async function disableNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api.unsubscribePush(sub.endpoint);
      await sub.unsubscribe();
    }
    S.pushEnabled = false;
    toast('Notifications turned off on this device');
  } catch (err) {
    toast(`Could not turn notifications off: ${err.message}`);
  }
  render();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}

/* ---------------------------------------------------------------- events */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || S.view !== 'app' || S.locked) return;
  if (S.lockMinutes && Date.now() - lastActive > S.lockMinutes * 60000) lockNow();
});

document.addEventListener('DOMContentLoaded', () => {
  armAutoLock();
  boot();
  const banner = document.getElementById('installhint');
  if (banner) banner.addEventListener('click', () => installApp());
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
});

async function installApp() {
  if (window.AndroidBridge) {
    toast('You are already using the Android app');
    return;
  }
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    return;
  }
  toast('Use your browser menu → "Install app" / "Add to Home screen"');
}

document.addEventListener('click', async (event) => {
  if (event.target.classList && event.target.classList.contains('modal') && !event.target.closest('[data-stop]')) {
    document.getElementById('modal').innerHTML = '';
    return;
  }
  if (S.bellOpen && !event.target.closest('.bellpanel') && !event.target.closest('[data-act="bell"]')) {
    S.bellOpen = false;
    render();
  }

  const target = event.target.closest('[data-act],[data-tab],[data-sort]');
  if (!target) return;

  if (target.hasAttribute('data-tab')) {
    S.tab = target.getAttribute('data-tab');
    S.bellOpen = false;
    S.drawer = false;
    if (S.tab === 'settings') await loadSettingsData();
    if (S.tab === 'notifications') loadInbox().catch(() => {});
    window.scrollTo(0, 0);
    render();
    return;
  }

  if (target.hasAttribute('data-sort')) {
    const collection = target.getAttribute('data-ek');
    const key = target.getAttribute('data-sort');
    const current = S.sort[collection];
    S.sort[collection] = { k: key, dir: current && current.k === key ? -current.dir : 1 };
    render();
    return;
  }

  const act = target.getAttribute('data-act');
  const collection = target.getAttribute('data-ek');
  const id = target.getAttribute('data-id');

  if (act === 'close') {
    if (target.classList.contains('modal') && event.target !== target) return;
    document.getElementById('modal').innerHTML = '';
    return;
  }
  event.preventDefault();

  switch (act) {
    case 'alerts':
      S.alertsOpen = !S.alertsOpen;
      return render();
    case 'theme':
      applyTheme(target.getAttribute('data-theme') || (S.theme === 'dark' ? 'light' : 'dark'));
      return render();
    case 'space': {
      const want = target.getAttribute('data-space') || 'family';
      const found = (S.profiles || []).find((p) => p.kind === want);
      return switchProfile(found ? found.id : S.profileId);
    }
    case 'space-cycle':
      return cycleProfile();
    case 'profile':
      return switchProfile(target.getAttribute('data-profile'));
    case 'drawer':
      S.drawer = !S.drawer;
      return render();
    case 'backup':
      return encryptedBackup();
    case 'backup-plain': {
      const payload = { exportedAt: new Date().toISOString(), profile: S.profile, settings: S.settings, data: S.db };
      download(
        `Family_Finance_Planner_${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(payload, null, 2),
        'application/json',
      );
      return undefined;
    }
    case 'restore-backup':
      return restoreFromFile();
    case 'inbox-filter':
      S.inboxFilter = target.getAttribute('data-profile') || '';
      return render();
    case 'goto-profile': {
      const profileId = target.getAttribute('data-profile');
      const tab = target.getAttribute('data-tab') || 'dashboard';
      if (profileId && profileId !== S.profileId) {
        S.tab = tab;
        return switchProfile(profileId);
      }
      S.tab = tab;
      return render();
    }
    case 'dismiss-update':
      S.update = null;
      return render();
    case 'role-set':
      return changeRole(target.getAttribute('data-id'), target.value);
    case 'bell-page':
      S.tab = 'notifications';
      S.bellOpen = false;
      loadInbox().catch(() => {});
      return render();
    case 'top':
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return undefined;
    case 'lock':
    case 'locknow':
      return lockNow();
    case 'save-lock': {
      const seconds = Number(document.getElementById('s_lock_custom').value);
      if (!Number.isFinite(seconds) || seconds < 15 || seconds > 86400) return toast('Use 15 to 86400 seconds');
      S.lockMinutes = Math.round((seconds / 60) * 100) / 100;
      lastActive = Date.now();
      try {
        localStorage.setItem(LOCK_KEY, String(S.lockMinutes));
      } catch {
        /* storage blocked */
      }
      toast(`Auto-lock after ${Math.round(seconds)}s`);
      return render();
    }
    case 'invite':
      await guard(async () => {
        const out = await api.createInvite();
        S.invite = out;
        render();
        toast('Invite code created');
      });
      return undefined;
    case 'member-del': {
      if (!confirm('Remove this member? Their personal and office books are deleted and they are signed out everywhere.')) return undefined;
      await guard(async () => {
        await api.removeMember(id);
        await loadSettingsData();
        render();
        toast('Member removed');
      });
      return undefined;
    }
    case 'lock-password': {
      const form = document.getElementById('lockpwfrm');
      if (form) form.style.display = 'block';
      const email = document.getElementById('lockemail');
      if (email) email.focus();
      return undefined;
    }
    case 'clear-data':
      if (!confirm('Delete every contact, bill, expense, policy, task and document in all books? Accounts and settings stay.')) return undefined;
      await guard(async () => {
        await api.clearData();
        S.rev = 0;
        await refresh();
        toast('All data cleared');
      });
      return undefined;
    case 'sample-data':
      if (!confirm('Replace everything with the starter sample data?')) return undefined;
      await guard(async () => {
        await api.sampleData();
        S.rev = 0;
        await refresh();
        toast('Sample data loaded');
      });
      return undefined;
    case 'bell':
      S.bellOpen = !S.bellOpen;
      return render();
    case 'note-read':
      await api.markRead(null);
      S.unread = 0;
      S.notifications = S.notifications.map((n) => ({ ...n, read_at: n.read_at || Date.now() }));
      S.profiles = (S.profiles || []).map((p) =>
        p.id === S.profileId ? { ...p, unread: 0 } : p,
      );
      loadInbox().catch(() => {});
      return render();
    case 'push-settings':
      S.bellOpen = false;
      S.tab = 'settings';
      await loadSettingsData();
      return render();
    case 'goto':
      S.tab = target.getAttribute('data-tab') || 'dashboard';
      S.bellOpen = false;
      if (S.tab === 'settings') await loadSettingsData();
      window.scrollTo(0, 0);
      return render();
    case 'template':
      download(
        `${COLLECTIONS[collection].label.replace(/\W+/g, '_')}_Template.csv`,
        csvTemplate(collection),
        'text/csv;charset=utf-8',
      );
      toast('Template downloaded - fill it in and import it back');
      return undefined;
    case 'wa':
    case 'sms': {
      const text = messageFor(target.getAttribute('data-target'));
      const phone = target.getAttribute('data-phone') || S.settings.mobile;
      const link = act === 'wa' ? whatsappLink(phone, text) : smsLink(phone, text);
      if (!link || !phone) {
        toast('Add a mobile number in Settings first');
        return undefined;
      }
      window.open(link, '_blank', 'noopener');
      return undefined;
    }
    case 'signup':
      S.authView = 'signup';
      S.error = '';
      return render();
    case 'tosignup':
      S.authView = 'signup';
      S.error = '';
      return render();
    case 'forgot':
      S.authView = 'forgot';
      S.error = '';
      return render();
    case 'tosignin':
    case 'back-to-login':
      S.authView = 'login';
      S.error = '';
      return render();
    case 'save-password':
      return savePassword();
    case 'ai-add':
      return addAi();
    case 'ai-test':
      await guard(async () => {
        const out = await api.testAiConnection(id);
        toast(`AI replied: ${out.reply}`);
      });
      return undefined;
    case 'ai-del':
      if (!confirm('Remove this AI connection?')) return undefined;
      await guard(async () => {
        await api.deleteAiConnection(id);
        await loadSettingsData();
        render();
        toast('Connection removed');
      });
      return undefined;
    case 'drive-del':
      if (!confirm('Delete this file permanently?')) return undefined;
      await guard(async () => {
        await api.deleteFile(id);
        await loadSettingsData();
        render();
        toast('File deleted');
      });
      return undefined;
    case 'scan':
      return scanCurrentForm();
    case 'add':
      return openForm(collection, {}, true);
    case 'edit': {
      const row = (S.db[collection] || []).find((r) => r.id === id);
      if (row) openForm(collection, row, false);
      return undefined;
    }
    case 'del': {
      if (!confirm('Delete this row?')) return undefined;
      await guard(async () => {
        await api.deleteRecord(collection, id);
        await refresh();
        toast('Deleted');
      });
      return undefined;
    }
    case 'done': {
      const status = collection === 'diary' ? 'Completed' : 'Paid';
      await guard(async () => {
        await api.updateRecord(collection, id, { status });
        await refresh();
        toast(`Marked ${status}`);
      });
      return undefined;
    }
    case 'pg':
      S.page[collection] = (S.page[collection] || 0) + Number(target.getAttribute('data-d'));
      return render();
    case 'csv':
      download(`${COLLECTIONS[collection].label.replace(/\W+/g, '_')}.csv`, csvOf(collection), 'text/csv;charset=utf-8');
      return undefined;
    case 'impcsv':
      return importCsv(collection);
    case 'saveset':
      return saveSettings();
    case 'ics': {
      const out = buildICS();
      download(calendarFileName(), out.text, 'text/calendar;charset=utf-8');
      toast(`${out.count} events prepared`);
      return undefined;
    }
    case 'backup': {
      const payload = { exportedAt: new Date().toISOString(), settings: S.settings, data: S.db };
      download(`Family_Finance_Planner_Backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
      return undefined;
    }
    case 'reset':
      if (!confirm('Replace everything with the original starter data? Your changes will be lost.')) return undefined;
      await guard(async () => {
        await api.resetData();
        await refresh();
        toast('Data reset');
      });
      return undefined;
    case 'change-pin':
      return changePin();
    case 'revoke-sessions':
      if (!confirm('Sign out every device, including this one?')) return undefined;
      await guard(async () => {
        await api.revokeAllSessions();
        setView('login', 'All devices were signed out.');
      });
      return undefined;
    case 'logout':
      await api.logout().catch(() => {});
      if (events) events.close();
      if (pollTimer) clearInterval(pollTimer);
      setView('login');
      return undefined;
    case 'push-on':
      return enableNotifications();
    case 'push-off':
      return disableNotifications();
    case 'push-test':
      await guard(async () => {
        const res = await api.testPush();
        toast(res.sent ? `Test sent to ${res.sent} device(s)` : 'No device is subscribed yet');
      });
      return undefined;
    case 'install':
      return installApp();
    default:
      return undefined;
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.hasAttribute && el.hasAttribute('data-q')) {
    const collection = el.getAttribute('data-q');
    S.q[collection] = el.value;
    S.page[collection] = 0;
    render();
  } else if (el.id === 'gsearch') {
    S.q[S.tab] = el.value;
    render();
  }
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  if (el && el.type === 'file' && el.hasAttribute && el.hasAttribute('data-file-field')) {
    if (!el.files || !el.files.length) return;
    await guard(async () => {
      const file = await uploadFromInput(el);
      toast(`${file.name} attached`);
    });
    return;
  }
  if (el && el.id === 's_lock') {
    S.lockMinutes = Number(el.value) || 0;
    lastActive = Date.now();
    try {
      localStorage.setItem(LOCK_KEY, String(S.lockMinutes));
    } catch {
      /* storage blocked */
    }
    toast(S.lockMinutes ? `Auto-lock after ${S.lockMinutes} min` : 'Auto-lock is off');
    return;
  }
  if (!el.hasAttribute || !el.hasAttribute('data-f')) return;
  const key = el.getAttribute('data-f');
  if (key === 'rel') {
    S.filter.rel = el.value;
    S.page.contacts = 0;
  } else {
    S.filter[key] = el.value;
    S.page[key] = 0;
  }
  render();
});  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (form.id === 'loginfrm') {
      event.preventDefault();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      if (!email || !password) return toast('Enter your email and password');
      await guard(async () => {
        await api.login({ email, password });
        S.error = '';
        await loadApp();
      }, 'Email or password is incorrect');
    } else if (form.id === 'pinfrm') {
      event.preventDefault();
      const pin = document.getElementById('pin').value.trim();
      if (!pin) return toast('Enter the family PIN');
      await guard(async () => {
        await api.login({ pin });
        S.error = '';
        await loadApp();
      }, 'Incorrect PIN');
    } else if (form.id === 'forgotfrm') {
      event.preventDefault();
      const email = document.getElementById('fp_email').value.trim();
      const pin = document.getElementById('fp_pin').value.trim();
      const password = document.getElementById('fp_newpass').value;
      const again = document.getElementById('fp_newpass2').value;
      if (!email || !pin) return toast('Enter your email and family PIN');
      if (password !== again) return toast('The two passwords do not match');
      await guard(async () => {
        await api.resetPassword(email, pin, password);
        S.error = '';
        S.authView = 'login';
        toast('Password reset. Sign in with your new password.');
        render();
      });
    } else if (form.id === 'signupfrm') {
      event.preventDefault();
      const name = document.getElementById('su_name').value.trim();
      const email = document.getElementById('su_email').value.trim();
      const password = document.getElementById('su_password').value;
      const again = document.getElementById('su_password2').value;
      const code = document.getElementById('su_code').value.trim();
      if (password !== again) return toast('The two passwords do not match');
      await guard(async () => {
        await api.signup(name, email, password, code);
        S.error = '';
        await loadApp();
        toast('Account created');
      });
    } else if (form.id === 'setupfrm') {
    event.preventDefault();
    const household = document.getElementById('household').value.trim() || 'Family Planner';
    const pin = document.getElementById('pin').value.trim();
    const pin2 = document.getElementById('pin2').value.trim();
    if (!/^\d{4,12}$/.test(pin)) return toast('PIN must be 4-12 digits');
    if (pin !== pin2) return toast('The two PINs do not match');
    await guard(async () => {
      await api.setup(household, pin);
      await loadApp();
      toast('Planner created');
    });
  } else if (form.id === 'lockfrm') {
    event.preventDefault();
    const pin = document.getElementById('lockpin').value.trim();
    if (!pin) return toast('Enter your PIN');
    await unlock({ pin });
  } else if (form.id === 'lockpwfrm') {
    event.preventDefault();
    await unlock({
      email: document.getElementById('lockemail').value.trim(),
      password: document.getElementById('lockpass').value,
    });
  } else if (form.id === 'frm') {
    event.preventDefault();
    await saveForm();
  }
});

/* --------------------------------------------------------------- actions */

/* ------------------------------------------------------- lock and books */

let lockTimer = null;

function lockNow() {
  if (S.locked) return;
  S.locked = true;
  S.lockError = '';
  // Server-side enforcement: the cookie is revoked, so every other tab and any
  // copied session stops working immediately; unlocking issues a fresh session.
  api.lockSession().catch(() => {});
  if (events) {
    events.close();
    events = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Nothing sensitive stays in this tab while it is locked: the rendered DOM is
  // replaced and the in-memory copy is dropped, not just hidden behind a blur.
  S.db = emptyDb();
  S.rev = 0;
  S.notifications = [];
  S.unread = 0;
  S.knownNotifications = new Set();
  S.files = [];
  S.activity = [];
  S.sessions = [];
  S.bellOpen = false;
  render();
}

async function unlock(credentials) {
  try {
    await api.login(credentials);
  } catch (err) {
    S.lockError =
      err.status === 429
        ? 'Too many attempts. Wait 15 minutes.'
        : err.status === 403
          ? 'This account has no PIN. Use the email and password option.'
          : 'That PIN or password is incorrect';
    render();
    return;
  }
  S.lockError = '';
  S.locked = false;
  lastActive = Date.now();
  await loadApp();
}

/**
 * Switch profile. The server validates membership and the new role, then the whole
 * dataset is dropped and reloaded so no row from the previous profile can linger
 * on screen or in memory.
 */
async function switchProfile(next) {
  S.drawer = false;
  if (!next || next === S.profileId) return render();
  await guard(
    async () => {
      const out = await api.switchProfile(next);
      api.setProfile(out.profile.id);
      S.profileId = out.profile.id;
      S.profile = out.profile;
      S.role = out.profile.role;
      S.space = out.profile.kind;
      try {
        localStorage.setItem(PROFILE_KEY, out.profile.id);
        localStorage.setItem(SPACE_KEY, out.profile.kind);
      } catch {
        /* storage blocked */
      }
      S.rev = 0;
      S.db = emptyDb();
      S.notifications = [];
      S.unread = 0;
      S.tab = ['dashboard', 'reports', 'notifications', 'settings', 'expenses', 'diary', 'contacts', 'budget', 'payments', 'subscriptions', 'loans', 'insurance', 'family'].includes(S.tab)
        ? S.tab
        : 'dashboard';
      await loadApp();
      announceProfile();
      toast(`Switched to ${out.profile.name}`);
    },
    'Could not switch profile',
  );
}

async function cycleProfile() {
  const list = S.profiles || [];
  if (list.length < 2) return switchProfile(S.profileId);
  const idx = list.findIndex((p) => p.id === S.profileId);
  return switchProfile(list[(idx + 1) % list.length].id);
}

function startAutoLockWatch() {
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    if (S.locked || S.view !== 'app' || !S.lockMinutes) return;
    if (Date.now() - lastActive > S.lockMinutes * 60000) lockNow();
  }, 4000);
}

function armAutoLock() {
  const bump = () => {
    lastActive = Date.now();
  };
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'focus'].forEach((name) => {
    document.addEventListener(name, bump, { passive: true });
  });
  startAutoLockWatch();
}

async function guard(fn, fallbackMessage = '') {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) {
      setView('login', 'Please sign in again.');
      return;
    }
    toast(fallbackMessage || err.message || 'Something went wrong');
  }
}

async function loadSettingsData() {
  try {
    const [activity, sessions, account, files, ai, family, members, audit] = await Promise.all([
      api.activity(),
      api.sessions(),
      api.account(),
      api.files(),
      api.aiConnections(),
      api.familyMembers(),
      api.profileMembers(S.profileId).catch(() => ({ members: [] })),
      api.auditLog(40).catch(() => ({ events: [] })),
    ]);
    S.members = family.members || [];
    S.profileMembers = members.members || [];
    S.audit = audit.events || [];
    S.account.id = family.me || '';
    S.account.role = family.role || account.role;
    S.activity = activity.activity || [];
    S.sessions = sessions.sessions || [];
    S.currentSession = sessions.current || '';
    S.account = account || {};
    S.files = files.files || [];
    S.filesTotal = files.totalBytes || 0;
    S.storage = files.storage !== false;
    S.aiConnections = ai.connections || [];
  } catch {
    S.activity = [];
    S.sessions = [];
  }
}

/* --------------------------------------------------------- backup / roles */

async function encryptedBackup() {
  const passphrase = window.prompt(
    'Choose a passphrase for this backup.\n\nIt encrypts the file on this device and is never sent to the server. Without it the backup cannot be restored.',
    '',
  );
  if (!passphrase) return;
  if (passphrase.length < 8) return toast('Use at least 8 characters for the passphrase');
  await guard(async () => {
    const payload = await api.exportProfile(S.profileId);
    payload.profile = S.profile;
    const file = await createBackupFile(payload, passphrase);
    download(file.name, file.text, 'application/json');
    await api.backupEvent('create', 'download', file.bytes).catch(() => {});
    toast('Encrypted backup downloaded — keep the passphrase safe');
  }, 'Could not create the backup');
}

async function restoreFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ffpbak,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const passphrase = window.prompt('Passphrase for this backup file', '');
    if (!passphrase) return;
    await guard(async () => {
      const { payload, envelope } = await readBackupFile(file, passphrase);
      const total = Object.values(envelope.counts || {}).reduce((n, v) => n + Number(v || 0), 0);
      const when = envelope.createdAt ? new Date(envelope.createdAt).toLocaleString() : 'unknown date';
      const ok = window.confirm(
        `Restore ${total} records from the backup made ${when}?\n\nThey are added to “${
          S.profile ? S.profile.name : 'this profile'
        }”. Existing records with the same id are updated; nothing is deleted first.`,
      );
      if (!ok) return;
      await api.backupEvent('restore', 'file', file.size).catch(() => {});
      const stats = await restorePayload(payload);
      S.rev = 0;
      await refresh();
      toast(`Restored ${stats.added} record${stats.added === 1 ? '' : 's'}`);
    }, 'Could not restore that backup');
  };
  input.click();
}

async function changeRole(userId, role) {
  if (!userId || !role) return;
  await guard(async () => {
    await api.setMemberRole(S.profileId, userId, role);
    await loadSettingsData();
    render();
    toast('Role updated');
  }, 'Could not change that role');
}

/** Only a release the server marks as required can raise the update banner. */
async function checkForUpdate() {
  try {
    const out = await api.version();
    if (!out) return;
    // Kept regardless of `minimum` so Settings can offer the Android build the
    // server actually publishes instead of a hard-coded path.
    if (out.apkUrl) S.release = out;
    if (!out.minimum) return;
    if (compareVersions(out.minimum, S.version) > 0) {
      S.update = { minimum: out.minimum, apkUrl: out.apkUrl || null, notes: out.notes || '' };
    }
  } catch {
    /* version checks are advisory */
  }
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

let formCollection = null;
let formRecordId = null;

function openForm(collection, record, isNew) {
  formCollection = collection;
  formRecordId = isNew ? null : record.id || null;
  document.getElementById('modal').innerHTML = views.formHtml(collection, record, isNew);
  const first = document.querySelector('#modal input, #modal select');
  if (first) first.focus();
}

async function saveForm() {
  if (!formCollection) return;
  const def = COLLECTIONS[formCollection];
  const doc = {};
  for (const f of def.fields) {
    const el = document.getElementById(`f_${f.k}`);
    if (!el) continue;
    if (f.t === 'file') {
      if (el.files && el.files.length && !el.dataset.fileId) {
        const uploaded = await uploadFromInput(el);
        doc[f.k] = uploaded.id;
      } else {
        doc[f.k] = el.dataset.fileId || '';
      }
      continue;
    }
    let value = el.value;
    if (f.t === 'money' || f.t === 'pct') value = value === '' ? 0 : Number(value);
    doc[f.k] = value;
  }
  await guard(async () => {
    if (formRecordId) await api.updateRecord(formCollection, formRecordId, doc);
    else await api.createRecord(formCollection, doc);
    document.getElementById('modal').innerHTML = '';
    formCollection = null;
    formRecordId = null;
    await refresh();
    toast('Saved');
  });
}

async function changePin() {
  const current = document.getElementById('p_cur').value.trim();
  const next = document.getElementById('p_new').value.trim();
  if (!/^\d{4,12}$/.test(next)) return toast('New PIN must be 4-12 digits');
  await guard(async () => {
    await api.changePin(current, next);
    toast('PIN changed. Other devices were signed out.');
    await loadSettingsData();
    render();
  });
}

async function saveSettings() {
  const settings = {
    household: document.getElementById('s_household').value.trim(),
    mobile: document.getElementById('s_mobile').value.trim(),
    alertTime: document.getElementById('s_time').value || '06:00',
    channel: document.getElementById('s_channel').value.trim(),
  };
  await guard(async () => {
    const out = await api.saveSettings(settings);
    S.settings = out.settings;
    toast('Settings saved');
    render();
  });
}

async function uploadFromInput(input) {
  const form = new FormData();
  form.append('file', input.files[0]);
  if (formCollection) form.append('collection', formCollection);
  if (formRecordId) form.append('recordId', formRecordId);
  const out = await api.uploadFile(form);
  input.dataset.fileId = out.file.id;
  const label = document.getElementById('filelabel');
  if (label) label.textContent = `${out.file.name} · ${Math.round(out.file.size / 1024)} KB attached`;
  return out.file;
}

async function scanCurrentForm() {
  const input = document.querySelector('#modal input[type="file"]');
  if (!input || !input.files || !input.files.length) return toast('Choose a photo of the bill first');
  await guard(async () => {
    const file = await uploadFromInput(input);
    toast('Reading the bill…');
    const result = await api.scanFile(file.id);
    const doc = result.doc || {};
    Object.keys(doc).forEach((key) => {
      const field = document.getElementById(`f_${key}`);
      if (field && field.type !== 'file') field.value = doc[key];
    });
    toast('Bill details filled in — check them and save');
  });
}

async function savePassword() {
  const email = document.getElementById('ac_email').value.trim();
  const current = document.getElementById('ac_current').value;
  const next = document.getElementById('ac_next').value;
  if (!email) return toast('Enter the email to sign in with');
  if (next.length < 8) return toast('Password needs at least 8 characters');
  await guard(async () => {
    const out = await api.setPassword(current, next, email);
    S.account.email = out.email;
    toast('Password saved. Other devices were signed out.');
    await loadSettingsData();
    render();
  });
}

async function addAi() {
  const provider = document.getElementById('ai_provider').value.trim();
  const baseUrl = document.getElementById('ai_url').value.trim();
  const model = document.getElementById('ai_model').value.trim();
  const apiKey = document.getElementById('ai_key').value.trim();
  if (!baseUrl || !model || !apiKey) return toast('Fill in the base URL, model and API key');
  await guard(async () => {
    await api.addAiConnection({ provider: provider || 'Custom', baseUrl, model, apiKey });
    await loadSettingsData();
    render();
    toast('AI tool connected');
  });
}

function messageFor(target) {
  if (!target || target === 'digest') return alertDigestText();
  if (target.startsWith('note:')) {
    const note = (S.notifications || []).find((n) => n.id === target.slice(5));
    return note ? notificationMessage(note) : alertDigestText();
  }
  const [collection, id] = target.split(':');
  const row = (S.db[collection] || []).find((r) => r.id === id);
  return row ? recordMessage(collection, row) : alertDigestText();
}

/** Import a CSV: the module template format, or a Google Contacts export. */
function importCsv(collection) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result || '');
      let parsed = docsFromCsv(collection, text);
      if ((!parsed.docs || !parsed.docs.length) && collection === 'contacts') {
        parsed = googleContactsToDocs(text);
      }
      if (!parsed.docs || !parsed.docs.length) return toast(parsed.error || 'Nothing to import in that file');
      await guard(async () => {
        const stats = await api.bulkImport(collection, parsed.docs);
        await refresh();
        toast(`${stats.added} row${stats.added === 1 ? '' : 's'} imported${stats.skipped ? `, ${stats.skipped} duplicates skipped` : ''}`);
      });
    };
    reader.readAsText(file, 'utf-8');
  };
  input.click();
}

/* --------------------------------------------------------------- startup */
