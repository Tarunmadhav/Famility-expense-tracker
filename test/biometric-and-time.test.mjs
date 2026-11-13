// Two decisions that are pure logic and were previously only checked by hand:
// what the lock screen offers, and what a typed due time means.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dueDraft, dueMoment, momentFromLocal } from '../web/src/deadlines.js';
import * as views from '../web/src/views.js';

// views.js reads the Android bridge off window, exactly as it does in the WebView.
globalThis.window = globalThis.window || {};

test('the lock screen offers the fingerprint button only when one is enrolled', () => {
  const original = globalThis.window.AndroidBridge;
  try {
    delete globalThis.window.AndroidBridge;
    let html = views.lockHtml('');
    assert.ok(!html.includes('bio-unlock'), 'a browser must not be offered a fingerprint');

    globalThis.window.AndroidBridge = { hasBiometric: () => false };
    html = views.lockHtml('');
    assert.ok(!html.includes('bio-unlock'), 'an unenrolled phone must not show the button');
    assert.match(html, /Set up fingerprint in phone settings to use it here\./);

    globalThis.window.AndroidBridge = { hasBiometric: () => true };
    html = views.lockHtml('');
    assert.match(html, /data-act="bio-unlock"/);
    assert.match(html, />Use fingerprint</);
    // Primary, not the secondary "g" style it used to carry.
    assert.match(html, /class="btn bio"/);

    globalThis.window.AndroidBridge = {
      hasBiometric() {
        throw new Error('bridge died');
      },
    };
    html = views.lockHtml('');
    assert.ok(!html.includes('bio-unlock'), 'a throwing bridge must not paint a button');
  } finally {
    if (original === undefined) delete globalThis.window.AndroidBridge;
    else globalThis.window.AndroidBridge = original;
  }
});

test('a readable due time becomes a real instant', () => {
  const draft = dueDraft('2026-11-13', '18:30');
  assert.equal(draft.ok, true);
  assert.equal(draft.dueTime, '18:30');
  assert.equal(draft.dueAt, momentFromLocal('2026-11-13', '18:30'));
  assert.ok(draft.dueAt.endsWith('Z'), 'the saved instant must be UTC');
  assert.equal(dueMoment({ due: '2026-11-13', dueAt: draft.dueAt }), Date.parse(draft.dueAt));
});

test('a loosely typed time is normalised, not rejected', () => {
  assert.deepEqual(dueDraft('2026-11-13', '9:30'), {
    ok: true,
    dueTime: '09:30',
    dueAt: momentFromLocal('2026-11-13', '09:30'),
  });
  assert.equal(dueDraft('2026-11-13', '0930').dueTime, '09:30');
});

test('an empty time stays an all-day task', () => {
  assert.deepEqual(dueDraft('2026-11-13', ''), { ok: true, dueTime: '', dueAt: '' });
  assert.deepEqual(dueDraft('2026-11-13', '   '), { ok: true, dueTime: '', dueAt: '' });
  // No dueAt means the banner treats it as due at the end of the day.
  assert.equal(dueMoment({ due: '2026-11-13' }), new Date(2026, 10, 13, 23, 59, 0, 0).getTime());
});

test('a bad time is refused with a message and nothing is saved', () => {
  for (const bad of ['25:00', '18:60', 'abc', '18:3', '1830x']) {
    const draft = dueDraft('2026-11-13', bad);
    assert.equal(draft.ok, false, `${bad} should be refused`);
    assert.match(draft.error, /Due time must look like 18:30/);
    assert.equal(draft.dueAt, undefined, 'a refusal must not carry an instant');
  }
});

test('a time with no date is refused instead of being dropped', () => {
  const draft = dueDraft('', '18:30');
  assert.equal(draft.ok, false);
  assert.match(draft.error, /Pick a due date first/);
});
