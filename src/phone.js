// One place decides what a usable WhatsApp/SMS number looks like.
//
// The planner sends nothing to a number it cannot trust, and Meta's Cloud API
// only accepts E.164, so every stored number is normalised to `+<country><rest>`
// with no spaces, dashes or brackets. A number that does not survive the check
// is rejected instead of being stored half-written.

/** The bare digits of a typed number, or '' when it is obviously not one. */
export function digitsOf(value) {
  return String(value == null ? '' : value).replace(/[^\d]/g, '');
}

/**
 * E.164 in, E.164 out. Returns `{ ok: true, number }` or `{ ok: false, reason }`.
 * 8–15 digits including the country code, and the country code cannot start at 0.
 */
export function normaliseMobile(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: true, number: '' };
  // A number typed without a country code is ambiguous (India, US and the UK all
  // look plausible), so it is rejected rather than guessed at.
  const plus = raw.trim().startsWith('+') ? '+' : '';
  if (!plus) return { ok: false, reason: 'missing-country-code' };
  const digits = digitsOf(raw);
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, reason: 'not-e164' };
  return { ok: true, number: `+${digits}` };
}
