// The + sheet, the Settings section order and the integration status lines are
// the three pieces of chrome the owner asked to be exact, so they are pinned here
// rather than checked by eye.

import test from 'node:test';
import assert from 'node:assert/strict';

import { S } from '../web/src/state.js';
import * as views from '../web/src/views.js';

// settingsView probes the browser for the Android bridge and the Notification API.
// Node has neither, and both references are evaluated per call, not at import.
globalThis.window = globalThis.window || {};
if (!('Notification' in globalThis)) globalThis.Notification = undefined;

/** Minimal state the Settings screen reads; nothing here touches the network. */
function seedState({ telegram, cloud } = {}) {
  S.me = { name: 'Test Owner' };
  S.account = { email: 'owner@example.com' };
  S.profile = { id: 'h:a', name: 'Household', role: 'owner', kind: 'family' };
  S.profileId = 'h:a';
  S.profiles = [S.profile];
  S.settings = { household: 'Home', alertTime: '06:00', channel: 'Push + in-app' };
  S.db = { family: [], contacts: [], subscriptions: [], diary: [], expenses: [] };
  S.activity = [];
  S.sessions = [];
  S.audit = [];
  S.profileMembers = [];
  S.members = [];
  S.files = [];
  S.aiConnections = [];
  S.security = {};
  S.backupRuns = [];
  S.backupFiles = {};
  S.cloudState = { enabled: false, frequency: 'daily', keep: 7, provider: null };
  S.calendarFeed = '';
  S.telegram = telegram || { configured: false, missing: ['TELEGRAM_WEBHOOK_SECRET'] };
  S.cloud = cloud || [];
}

test('the + sheet offers exactly two choices', () => {
  const html = views.addSheetHtml();
  const acts = [...html.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]);
  const choices = acts.filter((a) => a === 'addone' || a === 'addimport');
  assert.deepEqual(choices, ['addone', 'addimport']);
  assert.deepEqual([...new Set(acts)].sort(), ['addimport', 'addone', 'close']);
  assert.match(html, /Add one entry/);
  assert.match(html, /Import CSV or Excel/);
});

test('Settings has five folded sections in order', () => {
  seedState();
  const html = views.settingsView();
  const heads = [...html.matchAll(/<details class="card fold section"><summary><h2>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Account', 'Security', 'Notifications', 'Backup', 'Data and About']);
  // Collapsed by default: every section opens as a heading, not a wall of cards.
  assert.equal([...html.matchAll(/<details class="card fold" open/g)].length, 0);
});

test('each control appears once, so nothing is duplicated across sections', () => {
  seedState({
    telegram: { configured: true, link: { username: 'someone', linkedAt: Date.now(), preview: 'generic' } },
    cloud: [{ id: 'google', label: 'Google Drive', configured: true, linkedAt: Date.now() }],
  });
  const html = views.settingsView();
  const once = ['change-pin', 'calendar-link', 'ics-copy', 'backup', 'restore-backup', 'lock', 'logout', 'push-on', 'cloud-link', 'cloud-upload'];
  for (const act of once) {
    const hits = [...html.matchAll(new RegExp(`data-act="${act}"`, 'g'))].length;
    assert.ok(hits <= 1, `${act} is rendered ${hits} times`);
  }
  // One backup card, one calendar card, one audit view.
  assert.equal([...html.matchAll(/<h2>Encrypted copy<\/h2>/g)].length, 1);
  assert.equal([...html.matchAll(/<h2>Calendar subscription<\/h2>/g)].length, 1);
  assert.equal([...html.matchAll(/Show activity/g)].length, 1);
});

test('each section carries at most one primary button', () => {
  seedState();
  const html = views.settingsView();
  const parts = html.split('<details class="card fold section">').slice(1);
  assert.equal(parts.length, 5);
  parts.forEach((part, i) => {
    const primaries = [...part.matchAll(/<button class="btn" /g)].length;
    assert.ok(primaries <= 1, `section ${i + 1} has ${primaries} primary buttons`);
  });
});

test('the destructive demo buttons are gone from Settings', () => {
  seedState();
  const html = views.settingsView();
  assert.ok(!html.includes('data-act="sample-data"'), 'Load sample data is still offered');
  assert.ok(!html.includes('data-act="clear-data"'), 'Clear all data is still offered');
});

test('an unconfigured Telegram shows the owner action, not a working card', () => {
  seedState({ telegram: { configured: false, missing: ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN'] } });
  const html = views.settingsView();
  assert.match(html, /data-state="setup"/);
  assert.match(html, /owner action needed: TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN/);
});

test('a linked Telegram shows connected', () => {
  seedState({ telegram: { configured: true, link: { username: 'someone', linkedAt: Date.now(), preview: 'generic' } } });
  const html = views.settingsView();
  assert.match(html, /data-state="on"/);
  assert.match(html, /Telegram connected/);
});

test('Drive reads not connected, not set up and error distinctly', () => {
  assert.equal(views.integrationStatus({ label: 'Google Drive', configured: true, linked: false }).state, 'off');
  assert.equal(
    views.integrationStatus({ label: 'Google Drive', configured: false, missing: ['GOOGLE_CLIENT_ID'] }).text,
    'Not set up — owner action needed: GOOGLE_CLIENT_ID',
  );
  const error = views.integrationStatus({ label: 'Google Drive', configured: true, linked: true, error: 'token expired' });
  assert.deepEqual(error, { state: 'error', text: 'Google Drive: token expired' });
});

test('status text is escaped, never trusted as markup', () => {
  const html = views.statusLine({ state: 'error', text: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
});
