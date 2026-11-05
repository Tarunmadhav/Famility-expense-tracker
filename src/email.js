// Outbound email for one-time passwords.
//
// Resend is used because a Worker needs nothing but an HTTPS POST and one API
// key. Until RESEND_API_KEY exists the caller gets an explicit 501 with the
// missing variable name; nothing silently pretends a message was sent.

import { HttpError } from './errors.js';

const ENDPOINT = 'https://api.resend.com/emails';

function fromAddress(env) {
  return env.MAIL_FROM || 'Family Planner <onboarding@resend.dev>';
}

export async function sendOtpEmail(env, { to, code, minutes }) {
  if (!env.RESEND_API_KEY) {
    throw new HttpError(
      501,
      'Email is not configured. Add RESEND_API_KEY (and optionally MAIL_FROM) as Worker secrets to enable email codes.',
    );
  }
  const text = [
    `Your Family Planner code is ${code}`,
    '',
    `It expires in ${minutes} minutes and can be used once.`,
    'If you did not ask for this, ignore the message: nobody can sign in with the code alone.',
  ].join('\n');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(env),
      to: [to],
      subject: `Family Planner code ${code}`,
      text,
    }),
  });
  if (!res.ok) {
    // The provider's body can contain the recipient address, so only the status
    // is logged and only a generic message reaches the client.
    console.error('otp email rejected', res.status);
    throw new HttpError(502, 'The email provider rejected the message. Try again later.');
  }
  return true;
}

export function emailConfigured(env) {
  return Boolean(env.RESEND_API_KEY);
}
