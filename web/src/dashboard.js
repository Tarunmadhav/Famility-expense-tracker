// Dashboard and reports. The dashboard answers "what needs my attention" with a
// small number of dense panels; the full tables and every chart live in Reports,
// so nothing has to be scrolled past to reach the numbers.

import { S } from './state.js';
import {
  bdayNext,
  billAlert,
  health,
  insStatus,
  kpis,
  openTasks,
  relC,
  selfC,
  spendByCategory,
  sum,
  taskDue,
} from './analytics.js';
import { PAL, barChart, donut } from './charts.js';
import { dfmt, daysTo, esc, money, num, stat } from './format.js';
import { currentKind } from './shell.js';
import { subscriptionsMonthly } from './views.js';

function kpi(label, value, hint, tab, tone) {
  return `<button class="kpi${tab ? ' click' : ''}" ${tab ? `data-tab="${tab}"` : ''} style="--c:${tone || 'var(--line)'}">
    <span class="kl">${esc(label)}</span>
    <span class="kv">${esc(String(value))}</span>
    ${hint ? `<span class="kh">${esc(hint)}</span>` : ''}
  </button>`;
}

function emptyRow(text) {
  return `<div class="lrow mut">${esc(text)}</div>`;
}

function listRows(rows, empty) {
  if (!rows.length) return emptyRow(empty);
  return rows.join('');
}

/** One compact, clickable line: title, meta, right-aligned value. */
function row({ title, meta, value, tone, act = '', collection = '', id = '', tab = '' }) {
  const attrs = act
    ? `data-act="${act}" data-ek="${collection}" data-id="${esc(id)}"`
    : tab
      ? `data-tab="${tab}"`
      : '';
  return `<button class="lrow" ${attrs}>
    <span class="lmain"><b>${esc(title)}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</span>
    <span class="lval"${tone ? ` style="color:${tone}"` : ''}>${esc(String(value))}</span>
  </button>`;
}

function panel(title, actionLabel, tab, body, extra = '') {
  return `<section class="card panel">
    <div class="phead"><h2>${esc(title)}</h2>
      ${actionLabel && tab ? `<button class="linkbtn" data-tab="${tab}">${esc(actionLabel)}</button>` : ''}
      ${extra}
    </div>
    <div class="pbody">${body}</div>
  </section>`;
}

export function dashboardHtml() {
  const kind = currentKind();
  if (kind === 'office') return officeDash();
  if (kind === 'personal') return personalDash();
  return familyDash();
}

/* ---------------------------------------------------------------- family */

function familyDash() {
  const k = kpis();
  const me = selfC();
  const family = S.db.family || [];
  const wife = relC('Wife') || relC('Spouse / Family');

  const bills = (S.db.payments || [])
    .filter((p) => p.status !== 'Paid')
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .slice(0, 5)
    .map((p) =>
      row({
        title: p.payee || 'Bill',
        meta: `${dfmt(p.due)} · ${daysTo(p.due)} left${p.contact ? ` · ${p.contact}` : ''}`,
        value: money(p.amount),
        tone: daysTo(p.due) <= 3 ? 'var(--bad)' : undefined,
        act: 'edit',
        collection: 'payments',
        id: p.id,
      }),
    );

  const tasks = openTasks()
    .sort((a, b) => taskDue(a).localeCompare(taskDue(b)))
    .slice(0, 5)
    .map((t) =>
      row({
        title: t.title || 'Task',
        meta: `${dfmt(taskDue(t))} · ${t.priority || 'Normal'}`,
        value: t.status || 'Pending',
        act: 'edit',
        collection: 'diary',
        id: t.id,
      }),
    );

  const birthdays = (S.db.contacts || [])
    .map((c) => ({ c, b: bdayNext(c) }))
    .filter((x) => x.b)
    .sort((a, b) => a.b.days - b.b.days)
    .slice(0, 4)
    .map((x) =>
      row({
        title: x.c.name,
        meta: `${x.c.rel || 'Contact'} · ${dfmt(x.c.bday)}`,
        value: x.b.days === 0 ? 'Today' : `in ${x.b.days}d`,
        tone: x.b.days <= 3 ? 'var(--warn)' : undefined,
        act: 'edit',
        collection: 'contacts',
        id: x.c.id,
      }),
    );

  const recent = (S.db.expenses || [])
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 6)
    .map((e) =>
      row({
        title: e.item || 'Expense',
        meta: `${dfmt(e.date)}${e.cat ? ` · ${e.cat}` : ''}`,
        value: money(e.amount),
        act: 'edit',
        collection: 'expenses',
        id: e.id,
      }),
    );

  const members = family.slice(0, 6);
  const strip = members.length
    ? `<div class="memberstrip">${members
        .map(
          (m) => `<button class="minimember" data-act="edit" data-ek="family" data-id="${esc(m.id)}">
            <span class="avatar">${esc(initialsOf(m.name))}</span>
            <span class="mmname">${esc(m.name)}</span>
            <span class="mmrel mut">${esc(m.relation || m.role || '')}</span>
          </button>`,
        )
        .join('')}</div>`
    : '<p class="mut">No family members yet. Add each person once and they appear in alerts and reports.</p>';

  return `<div class="dash">
    <section class="hero">
      <div><h2>Good to see you${me.name ? `, ${esc(me.name.split(' ')[0])}` : ''}</h2>
        <!-- The deadline strip above already counts open and overdue tasks, so this
             line keeps to the money and drops the repeated task number. -->
        <p class="mut">${esc(S.profile ? S.profile.name : 'Family')} · ${k.unpaid > 0 ? `${money(k.unpaid)} in unpaid bills` : 'no unpaid bills'}</p></div>
    </section>

    <div class="stats">
      ${kpi('Monthly income', money(k.income), 'planned vs actual in Budget', 'budget', '#15803d')}
      ${kpi('Monthly spend', money(k.expenses), 'excluding logged daily spend', 'budget', '#c2410c')}
      ${kpi('Surplus', money(k.surplus), `${(k.surplus >= 0 ? 'saving' : 'deficit')} this month`, 'budget', k.surplus >= 0 ? '#1d4ed8' : '#b91c1c')}
      ${kpi('Unpaid bills', money(k.unpaid), `${(S.db.payments || []).filter((p) => p.status !== 'Paid').length} awaiting payment`, 'payments', '#6d28d9')}
    </div>

    <div class="split wide">
      <section class="card chart">
        <div class="phead"><h2>Cash flow</h2><span class="mut small">planned vs actual</span></div>
        ${barChart('', ['Income', 'Expenses', 'Surplus'], [
          { n: 'Planned', c: PAL[0], v: [sum(S.db.budgetIn, 'planned'), sum(S.db.budgetEx, 'planned'), sum(S.db.budgetIn, 'planned') - sum(S.db.budgetEx, 'planned')] },
          { n: 'Actual', c: PAL[1], v: [k.income, k.expenses, k.surplus] },
        ])}
      </section>
      <section class="card chart">
        <div class="phead"><h2>Where money goes</h2><button class="linkbtn" data-tab="expenses">Open</button></div>
        ${donut('', spendByCategory().slice(0, 6).map((c) => ({ l: c.l, v: c.v, money: 1 })))}
      </section>
    </div>

    <div class="split wide">
      ${panel('Bills due', 'All bills', 'payments', listRows(bills, 'Nothing due — every bill is paid.'))}
      ${panel('Tasks', 'Open diary', 'diary', listRows(tasks, 'No open tasks.'))}
    </div>

    <div class="split wide">
      ${panel('Recent spending', 'All expenses', 'expenses', listRows(recent, 'No expenses logged yet.'))}
      ${panel('Upcoming birthdays', 'Contacts', 'contacts', listRows(birthdays, 'No birthdays recorded.'))}
    </div>

    <section class="card">
      <div class="phead"><h2>Household</h2><button class="linkbtn" data-tab="family">Manage</button></div>
      ${strip}
      ${wife && wife.name ? `<p class="mut small" style="margin:8px 0 0">Spouse: ${esc(wife.name)}${wife.mobile ? ` · ${esc(wife.mobile)}` : ''}</p>` : ''}
    </section>
  </div>`;
}

function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/* ---------------------------------------------------------------- office */

function officeDash() {
  const expenses = S.db.expenses || [];
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = expenses.filter((e) => String(e.date || '').startsWith(month));
  const spend = sum(thisMonth, 'amount');
  const unpaid = sum(
    expenses.filter((e) => e.status !== 'Paid'),
    'amount',
  );
  const tasks = openTasks();
  const contacts = (S.db.contacts || []).length;

  const recent = expenses
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 7)
    .map((e) =>
      row({
        title: e.item || 'Expenditure',
        meta: `${dfmt(e.date)}${e.cat ? ` · ${e.cat}` : ''}${e.method ? ` · ${e.method}` : ''}`,
        value: money(e.amount),
        act: 'edit',
        collection: 'expenses',
        id: e.id,
      }),
    );

  const taskRows = tasks
    .sort((a, b) => taskDue(a).localeCompare(taskDue(b)))
    .slice(0, 6)
    .map((t) =>
      row({
        title: t.title || 'Task',
        meta: `${dfmt(taskDue(t))} · ${t.priority || 'Normal'}`,
        value: t.status || 'Pending',
        act: 'edit',
        collection: 'diary',
        id: t.id,
      }),
    );

  const byCategory = {};
  for (const e of thisMonth) {
    const key = e.cat || 'Uncategorised';
    byCategory[key] = (byCategory[key] || 0) + num(e.amount);
  }

  return `<div class="dash office">
    <section class="hero">
      <div><h2>Office overview</h2>
        <p class="mut">${esc(S.profile ? S.profile.name : 'Office')} · ${thisMonth.length} entries this month</p></div>
    </section>

    <div class="stats">
      ${kpi('This month', money(spend), `${thisMonth.length} entries`, 'expenses', '#334155')}
      ${kpi('Awaiting payment', money(unpaid), 'unpaid entries', 'expenses', '#b91c1c')}
      ${kpi('Open tasks', tasks.length, 'not completed', 'diary', '#0f766e')}
      ${kpi('Directory', contacts, 'business contacts', 'contacts', '#6d28d9')}
    </div>

    <div class="split wide">
      <section class="card chart">
        <div class="phead"><h2>Spend by category</h2><span class="mut small">this month</span></div>
        ${barChart('', Object.keys(byCategory), [
          { n: 'This month', c: PAL[1], v: Object.values(byCategory) },
        ], true)}
      </section>
      ${panel('Recent expenditure', 'Open ledger', 'expenses', listRows(recent, 'No expenditure recorded this month.'))}
    </div>

    ${panel('Open tasks', 'Task board', 'diary', listRows(taskRows, 'No open tasks.'))}
  </div>`;
}

/* -------------------------------------------------------------- personal */

function personalDash() {
  const expenses = S.db.expenses || [];
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = expenses.filter((e) => String(e.date || '').startsWith(month));
  const spend = sum(thisMonth, 'amount');
  const unpaid = sum(expenses.filter((e) => e.status !== 'Paid'), 'amount');
  const tasks = openTasks();
  const subs = subscriptionsMonthly();

  const recent = expenses
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 7)
    .map((e) =>
      row({
        title: e.item || 'Expense',
        meta: `${dfmt(e.date)}${e.cat ? ` · ${e.cat}` : ''}`,
        value: money(e.amount),
        act: 'edit',
        collection: 'expenses',
        id: e.id,
      }),
    );

  const taskRows = tasks
    .sort((a, b) => taskDue(a).localeCompare(taskDue(b)))
    .slice(0, 6)
    .map((t) =>
      row({
        title: t.title || 'Task',
        meta: dfmt(taskDue(t)),
        value: t.status || 'Pending',
        act: 'edit',
        collection: 'diary',
        id: t.id,
      }),
    );

  return `<div class="dash">
    <section class="hero">
      <div><h2>My money</h2>
        <p class="mut">Private to ${esc(S.me.name || 'you')} · ${thisMonth.length} entries this month</p></div>
    </section>

    <div class="stats">
      ${kpi('This month', money(spend), `${thisMonth.length} entries`, 'expenses', '#6d28d9')}
      ${kpi('Awaiting payment', money(unpaid), 'unpaid entries', 'expenses', '#b91c1c')}
      ${kpi('Open tasks', tasks.length, 'personal to-dos', 'diary', '#0f766e')}
      ${kpi('Subscriptions', money(subs), 'per month', 'subscriptions', '#7c3aed')}
    </div>

    <div class="split wide">
      <section class="card chart">
        <div class="phead"><h2>My spending mix</h2><span class="mut small">logged daily spend</span></div>
        ${donut('', spendByCategory().slice(0, 6).map((c) => ({ l: c.l, v: c.v, money: 1 })))}
      </section>
      ${panel('Recent spending', 'All', 'expenses', listRows(recent, 'Nothing logged yet.'))}
    </div>

    ${panel('My tasks', 'Diary', 'diary', listRows(taskRows, 'No open tasks.'))}
  </div>`;
}

/* --------------------------------------------------------------- reports */

function watch(title, dark, tint, heads, rows) {
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${heads.length}" class="mut">Nothing to show</td></tr>`;
  return `<section class="card"><div class="phead"><h2>${title}</h2></div>
    <div class="tw"><table style="--tint:${tint};--dark:${dark}"><thead><tr>${heads
      .map((h) => `<th>${h}</th>`)
      .join('')}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

export function reportsHtml() {
  const k = kpis();
  const h = health();

  const bills = (S.db.payments || [])
    .slice()
    .sort((a, b) => (a.status === 'Paid') - (b.status === 'Paid') || String(a.due).localeCompare(String(b.due)))
    .slice(0, 12)
    .map((p) => [esc(p.payee), money(p.amount), dfmt(p.due), p.status === 'Paid' ? '-' : daysTo(p.due), stat(billAlert(p))]);

  const renewals = (S.db.insurance || [])
    .slice()
    .sort((a, b) => String(a.renewal).localeCompare(String(b.renewal)))
    .map((p) => [esc(p.name), money(p.sum), money(p.premium), dfmt(p.renewal), daysTo(p.renewal), stat(insStatus(p))]);

  const tasks = openTasks()
    .sort((a, b) => taskDue(a).localeCompare(taskDue(b)))
    .map((t) => [esc(t.title), dfmt(taskDue(t)), stat(t.priority), stat(t.status), esc(t.follow)]);

  const birthdays = (S.db.contacts || [])
    .map((c) => ({ c, b: bdayNext(c) }))
    .filter((x) => x.b)
    .sort((a, b) => a.b.days - b.b.days)
    .slice(0, 12)
    .map((x) => [esc(x.c.name), esc(x.c.rel), dfmt(x.c.bday), x.b.days, x.b.age || '', esc(x.c.mobile)]);

  return `<div class="dash">
    <section class="hero"><div><h2>Reports</h2><p class="mut">Health, trends and the detailed lists for this profile.</p></div>
      <div class="heroacts"><button class="btn s g" data-act="ics">Calendar (.ics)</button><button class="btn s g" data-act="backup">Encrypted backup</button></div>
    </section>

    <div class="stats">
      ${kpi('Savings rate', `${(h.savingRate * 100).toFixed(1)}%`, 'income kept', '', h.savingRate >= 0.2 ? '#15803d' : '#b54708')}
      ${kpi('EMI / income', `${(h.dti * 100).toFixed(1)}%`, 'debt pressure', 'loans', h.dti <= 0.35 ? '#15803d' : '#b54708')}
      ${kpi('Budget used', `${(h.budgetUse * 100).toFixed(1)}%`, 'of planned spend', 'budget', h.budgetUse <= 1 ? '#15803d' : '#b91c1c')}
      ${kpi('Cover multiple', `${h.coverMultiple.toFixed(1)}x`, 'insurance vs 1yr spend', 'insurance', '#1d4ed8')}
    </div>

    <div class="split wide">
      <section class="card chart">${barChart('Monthly expenses by category', (S.db.budgetEx || []).map((r) => r.source), [
        { n: 'Planned', c: PAL[0], v: (S.db.budgetEx || []).map((r) => num(r.planned)) },
        { n: 'Actual', c: PAL[1], v: (S.db.budgetEx || []).map((r) => num(r.actual)) },
      ], true)}</section>
      <section class="card chart">${barChart('Loans: outstanding vs EMI', (S.db.loans || []).map((l) => l.name), [
        { n: 'Outstanding', c: PAL[4], v: (S.db.loans || []).map((l) => num(l.outstanding)) },
        { n: 'Monthly EMI', c: PAL[3], v: (S.db.loans || []).map((l) => num(l.emi)) },
      ])}</section>
    </div>

    <div class="split wide">
      <section class="card chart">${barChart('Insurance coverage', (S.db.insurance || []).map((l) => l.name), [
        { n: 'Coverage', c: PAL[0], v: (S.db.insurance || []).map((l) => num(l.sum)) },
      ])}</section>
      <section class="card chart">${donut('Diary status', [
        { l: 'Completed', v: (S.db.diary || []).filter((d) => d.status === 'Completed').length, c: '#15803d' },
        { l: 'Pending', v: (S.db.diary || []).filter((d) => d.status === 'Pending').length, c: '#b54708' },
        { l: 'Incomplete', v: (S.db.diary || []).filter((d) => d.status === 'Incomplete').length, c: '#b91c1c' },
      ])}</section>
    </div>

    ${watch('Bills & payment dues', '#6d28d9', '#ebe3fb', ['Bill', 'Amount', 'Due', 'Days left', 'Alert'], bills)}
    ${watch('Insurance renewals', '#1d4ed8', '#dee8fc', ['Policy', 'Coverage', 'Premium', 'Renewal', 'Days', 'Status'], renewals)}
    ${watch('Open tasks', '#be185d', '#fbddeb', ['Task', 'Due', 'Priority', 'Status', 'Follow-up'], tasks)}
    ${watch('Upcoming birthdays', '#0f766e', '#ddf2ee', ['Name', 'Relationship', 'Birthday', 'In (days)', 'Turning', 'Mobile'], birthdays)}

    <section class="card">
      <div class="phead"><h2>Totals</h2></div>
      <div class="totals">
        <div><span>Contacts</span><b>${k.contacts.toLocaleString('en-IN')}</b></div>
        <div><span>Outstanding debt</span><b>${money(k.debt)}</b></div>
        <div><span>Monthly EMI</span><b>${money(k.emi)}</b></div>
        <div><span>Insurance cover</span><b>${money(k.cover)}</b></div>
        <div><span>Subscriptions / month</span><b>${money(subscriptionsMonthly())}</b></div>
      </div>
    </section>
  </div>`;
}

