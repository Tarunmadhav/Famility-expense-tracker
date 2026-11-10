// WhatsApp outbound notifications: the send path must be opt-in, must name what is
// missing, and must never report a message it did not send. The Graph endpoint is
// stubbed here — the credential logic is what these tests are about.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sendWhatsappTemplate, whatsappMessagingConfigured, whatsappMessagingMissing } from '../src/whatsapp.js';

const FULL = {
  WHATSAPP_MESSAGING: 'on',
  WHATSAPP_TOKEN: 'test-token-not-real',
  WHATSAPP_PHONE_ID: '1234567890',
  WHATSAPP_TEMPLATE: 'bill_due_reminder',
};

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('without configuration nothing is sent and nothing is faked', async () => {
  const calls = stubFetch();
  const out = await sendWhatsappTemplate({}, '+919876543210', { params: ['Electricity', '₹2,400'] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not-configured');
  assert.deepEqual(out.missing, ['WHATSAPP_MESSAGING=on', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TEMPLATE']);
  assert.equal(calls.length, 0, 'a request went out without credentials');
});

test('credentials without the flag still send nothing', async () => {
  const calls = stubFetch();
  const env = { ...FULL, WHATSAPP_MESSAGING: 'off' };
  assert.equal(whatsappMessagingConfigured(env), false);
  assert.deepEqual(whatsappMessagingMissing(env), ['WHATSAPP_MESSAGING=on']);
  const out = await sendWhatsappTemplate(env, '+919876543210', {});
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

test('a template send carries the approved template, the digits and the parameters', async () => {
  const calls = stubFetch();
  const out = await sendWhatsappTemplate(FULL, ' +91 98765 43210 ', { params: ['Electricity', '₹2,400'] });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token-not-real');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.type, 'template');
  assert.equal(body.to, '919876543210');
  assert.equal(body.template.name, 'bill_due_reminder');
  assert.deepEqual(body.template.components[0].parameters.map((p) => p.text), ['Electricity', '₹2,400']);
});

test('a number without a country code is refused before any request', async () => {
  const calls = stubFetch();
  const out = await sendWhatsappTemplate(FULL, '9876543210', {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'bad-number');
  assert.equal(calls.length, 0);
});

test('a provider failure is reported and the token is not logged', async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  globalThis.fetch = async () => new Response('{"error":{"message":"bad template"}}', { status: 400 });
  try {
    const out = await sendWhatsappTemplate(FULL, '+919876543210', {});
    assert.deepEqual(out, { ok: false, reason: 'provider-400' });
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.length > 0, 'a failed send logged nothing');
  assert.ok(!logged.join(' ').includes(FULL.WHATSAPP_TOKEN), 'the token was written to the log');
});
