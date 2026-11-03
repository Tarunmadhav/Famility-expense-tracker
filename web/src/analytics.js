// All analytics from the original planner, plus a compact financial-health block.

import { S } from './state.js';
import { daysTo, iso, num, pd, today } from './format.js';

export function sum(rows, key) {
  return (rows || []).reduce((s, r) => s + num(r[key]), 0);
}

export function selfC() {
  return (S.db.contacts || []).find((c) => c.rel === 'Self') || {};
}

export function relC(rel, pref) {
  const matches = (S.db.contacts || []).filter((c) => c.rel === rel);
  if (pref) {
    const preferred = matches.find((c) => String(c.name || '').indexOf(pref) === 0);
    if (preferred) return preferred;
  }
  return matches[0] || {};
}

export function kpis() {
  const income = sum(S.db.budgetIn, 'actual');
  const expenses = sum(S.db.budgetEx, 'actual');
  return {
    income,
    expenses,
    surplus: income - expenses,
    debt: sum(S.db.loans, 'outstanding'),
    emi: sum(S.db.loans, 'emi'),
    daily: sum(S.db.expenses, 'amount'),
    unpaid: sum((S.db.payments || []).filter((p) => p.status !== 'Paid'), 'amount'),
    cover: sum(S.db.insurance, 'sum'),
    premium: sum(S.db.insurance, 'premium'),
    pending: (S.db.diary || []).filter((d) => d.status !== 'Completed').length,
    contacts: (S.db.contacts || []).length,
  };
}

/** Extra ratios derived from the same numbers (kept separate from the KPI cards). */
export function health() {
  const k = kpis();
  const savingRate = k.income > 0 ? k.surplus / k.income : 0;
  const dti = k.income > 0 ? (k.debt > 0 ? k.emi / k.income : 0) : 0;
  const coverMultiple = k.expenses > 0 ? k.cover / (k.expenses * 12) : 0;
  const plannedIn = sum(S.db.budgetIn, 'planned');
  const plannedEx = sum(S.db.budgetEx, 'planned');
  const budgetUse = plannedEx > 0 ? k.expenses / plannedEx : 0;
  return { savingRate, dti, coverMultiple, budgetUse, plannedSurplus: plannedIn - plannedEx };
}

export function openTasks() {
  return (S.db.diary || []).filter((t) => t.status !== 'Completed');
}

export function taskDue(t) {
  if (t.due) return t.due;
  const base = pd(t.date) || today();
  let next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  if (next < today()) next = new Date(today().getTime() + 86400000);
  return iso(next);
}

export function bdayNext(c) {
  const s = c.bday || '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) || s.match(/^(--)-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const t = today();
  let next = new Date(t.getFullYear(), month, day);
  if (next < t) next = new Date(t.getFullYear() + 1, month, day);
  const age = m[1] !== '--' && Number(m[1]) > 1900 ? next.getFullYear() - Number(m[1]) : null;
  return { date: next, days: Math.round((next - t) / 86400000), age };
}

export function billAlert(r) {
  if (r.status === 'Paid') return 'Suppressed (Paid)';
  const d = daysTo(r.due);
  if (d == null) return '';
  if (d < 0) return 'OVERDUE';
  if (d === 0) return 'DUE TODAY';
  if (d <= 3) return 'Due soon';
  return 'Scheduled';
}

export function insStatus(r) {
  const d = daysTo(r.renewal);
  if (d == null) return '';
  if (d <= 0) return 'EXPIRED';
  if (d <= 30) return 'URGENT (<30 days)';
  if (d <= 60) return 'Upcoming (<60 days)';
  return 'Active / Safe';
}

export function alertsList() {
  const list = [];
  (S.db.payments || []).forEach((p) => {
    if (p.status === 'Paid') return;
    const d = daysTo(p.due);
    if (d != null && d <= 3) list.push({ t: `${d < 0 ? 'OVERDUE ' : d === 0 ? 'DUE TODAY ' : `Due in ${d}d `}- ${p.payee}`, d, tab: 'payments' });
  });
  (S.db.insurance || []).forEach((p) => {
    const d = daysTo(p.renewal);
    if (d != null && d >= 0 && d <= 30) list.push({ t: `Renewal in ${d}d - ${p.name}`, d, tab: 'insurance' });
  });
  openTasks().forEach((t) => {
    const d = daysTo(taskDue(t));
    if (d != null && d <= 3) list.push({ t: `${d < 0 ? 'Overdue task - ' : `Task in ${d}d - `}${t.title}`, d, tab: 'diary' });
  });
  const contacts = [...(S.db.contacts || []), ...(S.db.family || [])];
  contacts.forEach((c) => {
    const b = bdayNext(c);
    if (b && b.days <= 7) list.push({ t: `🎂 ${c.name}${b.days === 0 ? ' - today!' : ` - in ${b.days}d`}`, d: b.days, tab: 'family' });
  });
  return list.sort((a, b) => a.d - b.d);
}

export function spendByCategory() {
  const cat = {};
  (S.db.expenses || []).forEach((e) => {
    const key = e.cat || 'Other';
    cat[key] = (cat[key] || 0) + num(e.amount);
  });
  return Object.keys(cat).map((c) => ({ l: c, v: cat[c] }));
}

/** Network / calendar helpers also need "today" for the digest line. */
export function digestLine() {
  const k = kpis();
  const alerts = alertsList().length;
  return `${k.pending} open task${k.pending === 1 ? '' : 's'} · ${alerts} alert${alerts === 1 ? '' : 's'} · surplus ${k.surplus >= 0 ? '' : '-'}₹${Math.abs(Math.round(k.surplus)).toLocaleString('en-IN')}`;
}
