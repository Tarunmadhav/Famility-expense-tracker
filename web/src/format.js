export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function money(n) {
  return `₹${Math.round(num(n)).toLocaleString('en-IN')}`;
}

export function compact(n) {
  const a = Math.abs(num(n));
  const s = n < 0 ? '-' : '';
  if (a >= 1e7) return `${s}${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${s}${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)}K`;
  return s + Math.round(a);
}

export function pd(isoStr) {
  if (!isoStr || !/^\d{4}-\d{2}-\d{2}/.test(isoStr)) return null;
  const p = isoStr.slice(0, 10).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

export function dfmt(isoStr) {
  const d = pd(isoStr);
  if (!d) {
    if (isoStr && isoStr[0] === '-') return String(isoStr).replace(/^--(\d\d)-(\d\d)$/, (m, a, b) => `${b}-${MON[Number(a) - 1]}`);
    return isoStr || '';
  }
  return `${String(d.getDate()).padStart(2, '0')}-${MON[d.getMonth()]}-${d.getFullYear()}`;
}

export function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysTo(isoStr) {
  const d = pd(isoStr);
  return d ? Math.round((d - today()) / 86400000) : null;
}

export function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

export function last10(s) {
  const d = digits(s);
  return d.length >= 10 ? d.slice(-10) : d;
}

export function relativeTime(ms) {
  const diff = Date.now() - Number(ms || 0);
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return dfmt(new Date(ms).toISOString().slice(0, 10));
}

export function badge(text, cls) {
  return `<span class="badge b-${cls}">${esc(text)}</span>`;
}

export function statClass(text) {
  const s = String(text).toLowerCase();
  let cls = 'n';
  if (/^(paid|completed|active|ok|on track|active \/ safe|no alert|scheduled)/.test(s) || s.indexOf('suppressed') === 0) cls = 'ok';
  if (/(unpaid|incomplete|overdue|expired|urgent|over budget|deficit|due today|high)/.test(s)) cls = 'bad';
  if (/(pending|due soon|upcoming|medium)/.test(s)) cls = 'warn';
  if (s === 'low') cls = 'ok';
  return cls;
}

export function stat(text) {
  return badge(text, statClass(text));
}

export function pct(v) {
  const n = num(v);
  return `${(n * 100).toFixed(2)}%`;
}
