// AI connector: any OpenAI-compatible endpoint (OpenAI, Z.ai/GLM, Groq, OpenRouter,
// local gateways...). The key lives in D1, is never returned to the browser, and is
// only ever sent to the URL the owner configured.

import { HttpError, activeAiConnection } from './store.js';

const SYSTEM_PROMPT = [
  'You read shopping bills, invoices and receipts and return structured data.',
  'Reply with JSON only, no prose and no code fences, using exactly these keys:',
  '{"merchant": string, "date": "YYYY-MM-DD" or "", "total": number, "tax": number,',
  ' "currency": "INR", "category": string, "paymentMethod": string,',
  ' "items": [{"name": string, "amount": number}]}',
  'If a value is unreadable use an empty string or 0. Never invent totals.',
].join(' ');

function toBase64(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function parseJsonReply(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpError(502, 'The AI reply did not contain JSON');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new HttpError(502, 'The AI reply was not valid JSON');
  }
}

async function callProvider(connection, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);
  try {
    const res = await fetch(`${connection.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(502, `AI provider error ${res.status}: ${text.slice(0, 160)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'AI provider returned a malformed response');
    }
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new HttpError(502, 'AI provider returned no content');
    return content;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.name === 'AbortError') throw new HttpError(504, 'The AI provider took too long to answer');
    throw new HttpError(502, `Could not reach the AI provider: ${String(err.message || err).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(connection) {
  const content = await callProvider(connection, {
    model: connection.model,
    max_tokens: 30,
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
  });
  return { ok: true, reply: String(content).slice(0, 120) };
}

/**
 * Send a bill/receipt to the configured vision model and map the answer onto an
 * expense document. Works for images; PDFs are sent as a data URL (providers that
 * support documents will read them, others will answer with empty fields).
 */
export async function scanReceipt(env, bytes, mime) {
  const connection = await activeAiConnection(env);
  if (!connection) {
    throw new HttpError(409, 'No AI tool connected yet. Add one in Settings → AI tools.');
  }

  const dataUrl = `data:${mime};base64,${toBase64(bytes)}`;
  const userContent = [
    { type: 'text', text: 'Extract the bill details from this document and reply with JSON only.' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];

  const base = {
    model: connection.model,
    temperature: 0,
    max_tokens: 700,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  };

  let content;
  try {
    content = await callProvider(connection, { ...base, response_format: { type: 'json_object' } });
  } catch (err) {
    // Some compatible gateways reject response_format; retry without it once.
    if (err instanceof HttpError && /400/.test(err.message)) {
      content = await callProvider(connection, base);
    } else {
      throw err;
    }
  }

  const data = parseJsonReply(content);
  const today = new Date().toISOString().slice(0, 10);
  const merchant = String(data.merchant || '').slice(0, 120);
  const total = Number(data.total) || 0;
  const items = Array.isArray(data.items) ? data.items.slice(0, 12) : [];
  const itemsText = items
    .map((item) => `${String(item.name || '').slice(0, 40)}${item.amount ? ` ₹${Math.round(Number(item.amount))}` : ''}`)
    .filter(Boolean)
    .join(', ');

  const doc = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(data.date || '')) ? data.date : today,
    item: (merchant ? `${merchant} bill` : 'Scanned bill').slice(0, 140),
    cat: String(data.category || 'Bills').slice(0, 60),
    method: String(data.paymentMethod || 'Other').slice(0, 60),
    amount: total,
    status: 'Unpaid',
    merchant: merchant || 'Scanned bill',
    phone: '',
    ref: `SCAN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    remarks: itemsText.slice(0, 380) || 'Auto-read from the uploaded document',
  };

  return { doc, raw: { merchant, total, currency: data.currency || 'INR', items } };
}
