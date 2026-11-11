// Rendering. Pure functions that read S and return HTML strings; app.js wires events.

import { COLLECTIONS } from './entities.js';
import { S } from './state.js';
import { billAlert, bdayNext, insStatus, kpis, selfC, sum } from './analytics.js';
import { digits, dfmt, esc, daysTo, iso, money, num, stat, today } from './format.js';
import {
  googleCalendarLink,
  notificationMessage,
  recordMessage,

} from './exporters.js';

/**
 * A real link to the shared Telegram bot. The username is a public Worker var,
 * so the card never asks people to go and find the bot by hand; the Android app
 * hands the t.me URL to the Telegram client because it is a foreign host.
 */
function tgChatLink(tg) {
  const user = String((tg && tg.botUsername) || '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{4,32}$/.test(user)) return '';
  const linked = Boolean(tg && tg.link);
  return `<a class="btn${linked ? ' g' : ''}" href="https://t.me/${esc(user)}" target="_blank" rel="noopener">${linked ? 'Open chat' : 'Start chatting'}</a>`;
}

/**
 * One status line per integration, in the four states the owner asked for:
 * not set up (owner action needed), not connected, connected, or an error with
 * the reason the server gave. Every card shows exactly one of these.
 */
export function integrationStatus({ label = 'Integration', configured = true, linked = false, missing = [], error = '' } = {}) {
  if (error) return { state: 'error', text: `${label}: ${error}` };
  if (!configured) {
    const names = (missing || []).filter(Boolean);
    return {
      state: 'setup',
      text: names.length
        ? `Not set up — owner action needed: ${names.join(', ')}`
        : `Not set up — owner action needed in ${label}`,
    };
  }
  if (!linked) return { state: 'off', text: `Not connected — ${label} is available` };
  return { state: 'on', text: `${label} connected` };
}

export function statusLine(status = {}) {
  return `<p class="statusline" data-state="${esc(status.state || 'off')}">${esc(status.text || '')}</p>`;
}

export function headerSub() {
  const k = kpis();
  const kind = S.profile ? S.profile.kind : 'family';
  const name = (S.profile && S.profile.name) || selfC().name || S.me.name || 'Family';
  const bits = [esc(name)];
  if (kind !== 'office') bits.push(`Surplus ${money(k.surplus)}`);
  bits.push(`${k.pending} open task${k.pending === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/* --------------------------------------------------------- notifications */

/** Cross-profile inbox: grouped by profile, labelled so nothing looks anonymous. */
export function inboxView() {
  const items = S.inbox || [];
  const profiles = S.profiles || [];
  const filter = S.inboxFilter || '';
  const visible = filter ? items.filter((n) => n.space === filter) : items;
  const unread = visible.filter((n) => !n.read_at).length;

  const chips = [
    `<button class="chipbtn${filter ? '' : ' on'}" data-act="inbox-filter" data-profile="">All profiles (${items.length})</button>`,
    ...profiles.map(
      (p) =>
        `<button class="chipbtn${filter === p.id ? ' on' : ''}" data-act="inbox-filter" data-profile="${esc(p.id)}">${esc(
          p.name,
        )}${p.unread ? ` · ${p.unread}` : ''}</button>`,
    ),
  ].join('');

  const rows = visible.length
    ? visible
        .map(
          (n) => `<div class="noterow${n.read_at ? '' : ' unread'} lvl-${esc(n.level || 'info')}">
            <div class="nrhead"><b>${esc(n.title)}</b><span class="mut small">${esc(
              n.profile_name || n.space,
            )}</span></div>
            <div class="mut">${esc(n.body)}</div>
            <div class="nrmeta"><span class="mut small">${esc(relative(n.created_at))}</span>
              <button class="linkbtn" data-act="goto-profile" data-profile="${esc(n.space)}" data-tab="${
                n.collection === 'payments' || n.collection === 'insurance' || n.collection === 'diary'
                  ? n.collection
                  : 'dashboard'
              }">Open in profile</button></div>
          </div>`,
        )
        .join('')
    : '<p class="mut" style="padding:12px">Nothing here yet. Bills, renewals, tasks and birthdays arrive automatically.</p>';

  return `<div class="dash">
    <section class="hero"><div><h2>Notifications</h2>
      <p class="mut">${items.length} total · ${unread} unread in this view. Every profile you can read reports here, even while you are working in another one.</p></div>
      <div class="heroacts"><button class="btn s g" data-act="note-read">Mark all read</button></div>
    </section>
    <div class="chiprow">${chips}</div>
    <section class="card"><div class="inbox">${rows}</div></section>
  </div>`;
}

/* -------------------------------------------------------------- updates */

export function updateBannerHtml() {
  const u = S.update || {};
  const action = u.apkUrl
    ? `<a class="btn s" href="${esc(u.apkUrl)}" target="_blank" rel="noopener">Download update</a>`
    : '<span class="mut small">Update via your app store</span>';
  return `<div class="updatebanner" role="status">
    <span>Version ${esc(u.minimum || '')} or newer is required.${u.notes ? ` ${esc(u.notes)}` : ''}</span>
    ${action}
    <button class="linkbtn" data-act="dismiss-update">Dismiss</button>
  </div>`;
}

/* ----------------------------------------------------------- table views */

function cellHtml(field, value) {
  if (field.t === 'file') {
    return value ? `<td class="filecell"><a href="/api/files/${esc(value)}" target="_blank" rel="noopener" title="Open attachment">📎</a></td>` : '<td class="mut">—</td>';
  }
  if (field.t === 'money') return `<td class="num">${value === '' || value == null ? '' : money(value)}</td>`;
  if (field.t === 'pct') return `<td class="num">${value === '' || value == null ? '' : `${(num(value) * 100).toFixed(2)}%`}</td>`;
  if (field.t === 'date') return `<td style="white-space:nowrap">${esc(dfmt(value))}</td>`;
  if (field.t === 'tel' && digits(value).length >= 8) return `<td style="white-space:nowrap"><a href="tel:${esc(String(value).replace(/\s/g, ''))}">${esc(value)}</a></td>`;
  if (field.t === 'select' || field.k === 'status') return `<td>${stat(value)}</td>`;
  return `<td>${esc(value)}</td>`;
}

export function computedColumns(collection, row) {
  if (collection === 'payments') {
    return [
      { v: row.status === 'Paid' ? '-' : daysTo(row.due), badge: false },
      { v: billAlert(row), badge: true },
    ];
  }
  if (collection === 'insurance') {
    return [
      { v: daysTo(row.renewal), badge: false },
      { v: insStatus(row), badge: true },
    ];
  }
  if (collection === 'diary') {
    const d = new Date(`${String(row.date || '').slice(0, 10)}T00:00:00`);
    const day = Number.isNaN(d.getTime()) ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return [
      { v: day, badge: false },
      { v: row.status === 'Completed' ? 'No alert needed' : 'Alert queued', badge: true },
    ];
  }
  if (collection === 'budgetIn') {
    return [
      { v: money(num(row.actual) - num(row.planned)), badge: false },
      { v: num(row.actual) >= num(row.planned) ? 'On track / surplus' : 'Deficit', badge: true },
    ];
  }
  if (collection === 'budgetEx') {
    return [
      { v: money(num(row.planned) - num(row.actual)), badge: false },
      { v: num(row.actual) > num(row.planned) ? 'OVER BUDGET' : 'OK', badge: true },
    ];
  }
  return [];
}

const COMPUTED_HEADERS = {
  payments: ['Days left', 'Alert'],
  insurance: ['Days left', 'Renewal status'],
  diary: ['Day', 'Alert'],
  budgetIn: ['Variance', 'Status'],
  budgetEx: ['Variance', 'Status'],
};

const FILTERS = {
  expenses: [['all', 'All', () => true], ['unpaid', 'Unpaid only', (r) => r.status !== 'Paid']],
  payments: [['all', 'All', () => true], ['unpaid', 'Unpaid only', (r) => r.status !== 'Paid']],
  diary: [['all', 'All', () => true], ['open', 'Uncompleted only', (r) => r.status !== 'Completed']],
};

const DONE_BUTTON = { expenses: 'Paid', payments: 'Paid', diary: 'Completed' };

export function tableView(collection) {
  const def = COLLECTIONS[collection];
  let rows = (S.db[collection] || []).map((r) => ({ r }));
  const query = String(S.q[collection] || '').toLowerCase();
  if (query) {
    rows = rows.filter(({ r }) => def.fields.some((f) => String(r[f.k] == null ? '' : r[f.k]).toLowerCase().includes(query)));
  }
  const filters = FILTERS[collection];
  const activeFilter = S.filter[collection] || 'all';
  if (filters && filters.find((f) => f[0] === activeFilter)) {
    const fn = filters.find((f) => f[0] === activeFilter)[2];
    rows = rows.filter(({ r }) => fn(r));
  }
  if (collection === 'contacts' && S.filter.rel) rows = rows.filter(({ r }) => r.rel === S.filter.rel);
  if (collection === 'subscriptions' && S.filter.sub) rows = rows.filter(({ r }) => r.status === S.filter.sub);

  const sort = S.sort[collection];
  if (sort) {
    rows.sort((a, b) => {
      const A = a.r[sort.k];
      const B = b.r[sort.k];
      const cmp = typeof A === 'number' || typeof B === 'number' ? num(A) - num(B) : String(A == null ? '' : A).localeCompare(String(B == null ? '' : B));
      return sort.dir * cmp;
    });
  }

  const total = rows.length;
  const pageSize = def.page;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(S.page[collection] || 0, pages - 1);
  S.page[collection] = page;
  const visible = rows.slice(page * pageSize, page * pageSize + pageSize);

  let html = `<div class="tools"><input class="search" data-q="${collection}" placeholder="Search ${esc(def.label)}..." value="${esc(S.q[collection] || '')}">`;
  if (filters) {
    html += `<select data-f="${collection}">${filters.map(([k, label]) => `<option value="${k}"${activeFilter === k ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  }
  if (collection === 'contacts') {
    const rels = [...new Set((S.db.contacts || []).map((c) => c.rel).filter(Boolean))].sort();
    html += `<select data-f="rel"><option value="">All relationships</option>${rels.map((r) => `<option${S.filter.rel === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
  }
  // The server refuses a contact import from any other account or book; hiding
  // the button for them is only a convenience, not the check.
  const canImport = collection !== 'contacts' || S.canImportContacts;
  html += `<button class="btn" style="background:${def.dark}" data-act="add" data-ek="${collection}">+ Add</button><button class="btn g" data-act="csv" data-ek="${collection}">Export</button><button class="btn g" data-act="template" data-ek="${collection}">Template</button>${canImport ? `<button class="btn g" data-act="impcsv" data-ek="${collection}">Import</button>` : ''}`;
  html += `<span class="mut right">${total.toLocaleString('en-IN')} row${total === 1 ? '' : 's'}</span></div>`;

  html += `<div class="tw"><table style="--tint:${def.tint};--dark:${def.dark}"><thead><tr>`;
  def.fields.forEach((f) => {
    const arrow = sort && sort.k === f.k ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
    html += `<th data-sort="${f.k}" data-ek="${collection}">${esc(f.l)}${arrow}</th>`;
  });
  (COMPUTED_HEADERS[collection] || []).forEach((label) => { html += `<th style="cursor:default">${label}</th>`; });
  html += '<th style="cursor:default"></th></tr></thead><tbody>';

  visible.forEach(({ r }) => {
    html += '<tr>';
    def.fields.forEach((f) => { html += cellHtml(f, r[f.k]); });
    computedColumns(collection, r).forEach((c) => { html += `<td${c.badge ? '' : ' class="num"'}>${c.badge ? stat(c.v) : esc(c.v === '' ? '' : c.v)}</td>`; });
    html += '<td class="act">';
    if (DONE_BUTTON[collection] && r.status !== DONE_BUTTON[collection]) {
      html += `<button class="btn s ok" data-act="done" data-ek="${collection}" data-id="${esc(r.id)}">✓ ${collection === 'diary' ? 'Done' : 'Paid'}</button> `;
    }
    if ((collection === 'payments' || collection === 'diary' || collection === 'insurance')) {
      html += `<a class="btn s g" target="_blank" rel="noopener" href="${esc(googleCalendarLink(collection, r))}">📅</a> `;
    }
    html += `<button class="btn s g" data-act="edit" data-ek="${collection}" data-id="${esc(r.id)}">Edit</button> <button class="btn s r" data-act="del" data-ek="${collection}" data-id="${esc(r.id)}">✕</button></td></tr>`;
  });
  if (!visible.length) {
    html += `<tr><td colspan="${def.fields.length + (COMPUTED_HEADERS[collection] || []).length + 1}" class="mut">No rows</td></tr>`;
  }
  html += '</tbody></table></div>';

  if (collection === 'budgetIn' || collection === 'budgetEx') {
    html += `<div class="card" style="margin-top:10px"><b>TOTAL</b> planned ${money(sum(S.db[collection], 'planned'))} · actual ${money(sum(S.db[collection], 'actual'))}</div>`;
  }

  if (pages > 1) {
    html += `<div class="pg"><button class="btn s g" data-act="pg" data-ek="${collection}" data-d="-1">◀</button> Page ${page + 1} / ${pages} <button class="btn s g" data-act="pg" data-ek="${collection}" data-d="1">▶</button></div>`;
  }
  return html;
}

export function budgetView() {
  return `<div class="bar" style="background:#15803D">INCOME STREAMS</div>${tableView('budgetIn')}<div class="bar" style="background:#B91C1C">MONTHLY EXPENSES &amp; COMMITMENTS</div>${tableView('budgetEx')}`;
}

/* --------------------------------------------------------------- settings */

export function settingsView() {
  const activityRows = (S.activity || [])
    .map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(COLLECTIONS[a.collection]?.label || a.collection)}</td><td>${stat(a.op === 'delete' ? 'Deleted' : 'Saved')}</td><td class="mut">${esc(relative(a.ts))}</td></tr>`)
    .join('') || '<tr><td colspan="4" class="mut">No changes yet</td></tr>';

  const sessionRows = (S.sessions || [])
    .map((s) => `<tr><td class="mut">${esc((s.ua || 'Unknown device').slice(0, 60))}</td><td>${relativetimeFrom(s.created_at)}</td><td>${s.id === S.currentSession ? stat('This device') : stat('Active')}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="mut">No sessions</td></tr>';

  const subTotal = subscriptionsMonthly();
  // The Android shell has no Notification API but does post to the tray through its
  // bridge, so the app must not tell a phone user that alerts are impossible.
  const nativeShell = typeof window !== 'undefined' && Boolean(window.AndroidBridge && window.AndroidBridge.notify);
  const pushState = nativeShell
    ? 'This phone shows planner alerts in the notification tray through the Android app.'
    : !('Notification' in window)
    ? 'This browser cannot show notifications.'
    : Notification.permission === 'granted' && S.pushEnabled
      ? 'Notifications are enabled on this device.'
      : Notification.permission === 'denied'
        ? 'Notifications are blocked in the browser settings for this site.'
        : 'Notifications are not enabled yet.';

  const security = S.security || {};
  return `
  <h2 class="grouphead">Account</h2>
  <div class="card"><h2>Your profile</h2>
      <div class="mrow"><span>Signed in as</span><b>${esc(S.me.name || '-')}</b></div>
      <div class="fld" style="margin-top:10px"><label for="ac_name">Display name</label><input id="ac_name" maxlength="60" value="${esc(S.me.name || '')}"></div>
      <button class="btn" data-act="save-name">Save name</button>
      <div class="mrow"><span>Email</span><b>${esc(S.account.email || 'Family PIN only')}</b></div>
      <div class="mrow"><span>Profile</span><b>${esc(S.profile ? `${S.profile.name} · ${S.profile.role}` : '-')}</b></div>
      <div class="mrow"><span>Your role here</span><b>${esc(S.profile ? S.profile.role : '-')}</b></div>
      <div class="fld" style="margin-top:10px"><label>Email for sign-in</label><input id="ac_email" type="email" value="${esc(S.account.email || '')}" placeholder="you@example.com"></div>
      <div class="fld"><label>Current PIN or password</label><input id="ac_current" type="password" autocomplete="current-password"></div>
      <div class="fld"><label>New password (8+ chars, letters and numbers)</label><input id="ac_next" type="password" autocomplete="new-password"></div>
      <button class="btn" data-act="save-password">Save password</button>
      <p class="mut">Members sign in with their own email; everyone shares this household's data.</p></div>
  <div class="card"><h2>People with access to this profile</h2>
    <p class="mut">${esc(S.profile ? S.profile.name : 'This profile')} is shared with the accounts below. Personal profiles are never shared, and office data never appears in the family profile. Roles decide what each person can do: an <b>Owner</b> manages everything, an <b>Admin</b> manages records and members, an <b>Editor</b> adds and edits, a <b>Viewer</b> only reads.</p>
    <div class="tw"><table><thead><tr><th>Member</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${(S.profileMembers || [])
      .map((m) => {
        const canManage = S.profile && (S.profile.role === 'owner' || S.profile.role === 'admin');
        const isOwner = S.profile && m.role === 'owner';
        const editable = canManage && !isOwner && m.id !== S.account.id;
        return `<tr><td>${esc(m.name)}${m.id === S.account.id ? ' <span class="chip">you</span>' : ''}</td><td class="mut">${esc(m.email || 'PIN only')}</td><td>${
          editable
            ? `<select data-act="role-set" data-id="${esc(m.id)}" aria-label="Role for ${esc(m.name)}">${['owner', 'admin', 'editor', 'viewer']
                .map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`)
                .join('')}</select>`
            : stat(m.role ? m.role[0].toUpperCase() + m.role.slice(1) : 'Member')
        }</td><td class="act">${canManage && !isOwner && m.id !== S.account.id ? `<button class="btn s r" data-act="member-del" data-id="${esc(m.id)}">Remove</button>` : ''}</td></tr>`;
      })
      .join('') || '<tr><td colspan="4" class="mut">Only you so far</td></tr>'}</tbody></table></div>
    ${S.profile && S.profile.role === 'owner' ? `<p style="margin-top:10px"><button class="btn" data-act="invite">Create invite code</button></p>${S.invite ? `<div class="alerts">Invite code <b>${esc(S.invite.code)}</b> — expires in 72 hours. This code is shown once, so copy it now.</div>` : ''}` : ''}
  </div>
  <div class="card"><h2>Two-factor &amp; recovery</h2>
    <p class="mut" style="margin-top:0">Two-factor adds a six-digit code from an authenticator app on top of your
      password or PIN. A recovery code resets a forgotten PIN without any device.</p>
    <div class="mrow"><span>Two-factor</span><b>${security.twoFactor ? 'On' : 'Off'}</b></div>
    <div class="mrow"><span>Recovery code</span><b>${security.hasRecovery ? 'Saved' : 'Not generated'}</b></div>
    ${security.setup
      ? `<div class="alerts" data-stop="1"><div>Add this key to your authenticator app, then enter the code it shows.</div>
          <div style="font:600 16px/1.6 ui-monospace,monospace;letter-spacing:1px;word-break:break-all;margin:8px 0" data-code="${esc(security.setup.secret)}">${esc(security.setup.secret)}</div>
          <button class="btn s g" data-act="copy-recovery" data-code="${esc(security.setup.secret)}">Copy key</button>
          ${security.setup.uri ? `<a class="btn s g" href="${esc(security.setup.uri)}">Open in app</a>` : ''}</div>
        <div class="fld"><label for="ac_totp">Code from the app</label><input id="ac_totp" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        <button class="btn" data-act="2fa-enable">Turn on two-factor</button>`
      : security.twoFactor
        ? `<div class="fld"><label for="ac_totp">Current code (to turn it off)</label><input id="ac_totp" inputmode="numeric" maxlength="6" placeholder="000000"></div>
          <div class="tools"><button class="btn g" data-act="2fa-off">Turn off two-factor</button><button class="btn g" data-act="recovery-new">New recovery code</button></div>`
        : `<div class="tools"><button class="btn" data-act="2fa-start">Set up two-factor</button><button class="btn g" data-act="recovery-new">${security.hasRecovery ? 'New recovery code' : 'Create recovery code'}</button></div>`}
  </div>
  <div class="card"><h2>Appearance &amp; security</h2>
    <div class="row2">
      <div class="fld"><label>Theme</label><div class="seg"><button data-act="theme" data-theme="light" class="${S.theme !== 'dark' ? 'on' : ''}">Light</button><button data-act="theme" data-theme="dark" class="${S.theme === 'dark' ? 'on' : ''}">Dark</button></div></div>
      <div class="fld"><label>Lock automatically after</label><select id="s_lock">${[[0.5, '30 seconds'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [0, 'Off (not recommended)']].map(([v, l]) => `<option value="${v}"${Number(S.lockMinutes) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="fld"><label>Custom timeout (seconds, 15-86400)</label><div class="tools" style="margin:0"><input id="s_lock_custom" type="number" min="15" max="86400" value="${Math.round((Number(S.lockMinutes) || 5) * 60)}" style="max-width:160px"><button class="btn s g" data-act="save-lock">Use custom</button></div></div>
    <p class="hint mut">The screen locks after that much inactivity and asks for your PIN or password again. Locking also clears the loaded data from this tab. <button class="linkbtn" data-act="lock">Lock now</button></p>
    <h3>Books</h3>
    <p class="hint mut">Switch with Family / Mine at the top. <b>Family</b> is the shared household book every member sees. <b>Mine</b> is private to your login — nobody else, including other family members, can read it.</p>
    <div class="seg" role="group" aria-label="Profiles">${(S.profiles || [])
      .map(
        (p) =>
          `<button data-act="profile" data-profile="${esc(p.id)}" class="${p.id === S.profileId ? 'on' : ''}">${esc(
            p.name,
          )}</button>`,
      )
      .join('')}</div></div>
  <div class="card"><h2>Household &amp; alert settings</h2>
    <div class="fld"><label>Household name</label><input id="s_household" placeholder="e.g. Gudipati household" value="${esc(S.settings.household || '')}"></div>
    <div class="fld"><label>Daily alert time (used for calendar events)</label><input id="s_time" type="time" value="${esc(S.settings.alertTime || '06:00')}"></div>
    <!-- alert channel field removed: nothing routes by it yet (docs/ROADMAP.md) --><div hidden><label for="s_channel">Alert channel</label><select id="s_channel">${['Push + in-app', 'Telegram', 'All channels'].map((c) => `<option${c === (S.settings.channel || 'Push + in-app') ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
    <p class="mut">Alerts are shown in the app and pushed to your devices; Telegram is used for the chats you linked above.</p>
    <button class="btn" data-act="saveset">Save settings</button></div>
  <div class="card"><h2>Security</h2>
    <div class="fld"><label>Current PIN</label><input id="p_cur" type="password" inputmode="numeric" autocomplete="current-password"></div>
    <div class="fld"><label>New PIN (4-12 digits)</label><input id="p_new" type="password" inputmode="numeric" autocomplete="new-password"></div>
    <button class="btn" data-act="change-pin">Change PIN</button>
    <div class="tw" style="margin-top:12px"><table><thead><tr><th>Device</th><th>Signed in</th><th>Status</th></tr></thead><tbody>${sessionRows}</tbody></table></div>
    <p style="margin-top:10px"><button class="btn r" data-act="revoke-sessions">Sign out all devices</button>
    <button class="btn g" data-act="logout">Sign out here</button></p></div>
  <div class="card"><h2>Security audit</h2>
    <p class="mut">Sign-ins, failed sign-ins, profile switches, sharing and role changes, exports and deletions, newest first. No financial values or keys are recorded here.</p>
    <details><summary class="mut">Show the last ${(S.audit || []).length} events</summary>
      <div class="tw"><table><thead><tr><th>When</th><th>Action</th><th>Who</th><th>Target</th></tr></thead><tbody>${(S.audit || [])
        .map(
          (e) => `<tr><td class="mut">${esc(relative(e.ts))}</td><td>${esc(e.action)}</td><td>${esc(e.actor_name || 'system')}</td><td class="mut">${esc(e.target || e.detail || '')}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="mut">No audit events yet</td></tr>'}</tbody></table></div>
    </details>
  </div>
  <div class="card"><h2>AI tools</h2>
    <p class="mut">Connect any OpenAI-compatible provider (OpenAI, Z.ai GLM, Groq, OpenRouter). The key is stored on the server, never sent to the browser, and only used when you scan a bill.</p>
    ${(S.aiConnections || []).length ? `<div class="tw"><table><thead><tr><th>Provider</th><th>Model</th><th>Base URL</th><th></th></tr></thead><tbody>${S.aiConnections.map((c) => `<tr><td>${esc(c.provider)}</td><td>${esc(c.model)}</td><td class="mut">${esc(c.base_url)}</td><td class="act"><button class="btn s g" data-act="ai-test" data-id="${esc(c.id)}">Test</button> <button class="btn s r" data-act="ai-del" data-id="${esc(c.id)}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No AI tool connected yet — bill scanning needs one.</p>'}
    <div class="fld" style="margin-top:10px"><label>Provider name</label><input id="ai_provider" placeholder="OpenAI / Z.ai / Groq"></div>
    <div class="fld"><label>Base URL</label><input id="ai_url" placeholder="https://api.openai.com/v1"></div>
    <div class="fld"><label>Model with image support</label><input id="ai_model" placeholder="gpt-4o-mini / glm-4v"></div>
    <div class="fld"><label>API key</label><input id="ai_key" type="password" autocomplete="off" placeholder="Stored on the server"></div>
    <button class="btn" data-act="ai-add">Connect AI tool</button></div>
  <h2 class="grouphead">Notifications</h2>
  <div class="card" id="card-telegram"><h2>Telegram</h2>
    ${statusLine(integrationStatus({
      label: 'Telegram',
      configured: !S.telegram || S.telegram.configured !== false,
      linked: Boolean(S.telegram && S.telegram.link),
      missing: (S.telegram && S.telegram.missing) || ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
    }))}
    ${(!S.telegram || S.telegram.configured === false)
      ? `<p class="hint mut">Add the missing Worker secrets above and point the bot's webhook at <code>/api/telegram/webhook</code>.</p>
          <div class="tools">${tgChatLink(S.telegram)}</div>`
      : S.telegram.link
        ? `<div class="mrow"><span>Connected chat</span><b>${esc(S.telegram.link.username ? `@${S.telegram.link.username}` : S.telegram.link.telegramUserId || 'Telegram')}</b></div>
          <div class="mrow"><span>Linked</span><b>${esc(relative(S.telegram.link.linkedAt))}</b></div>
          ${S.telegram.link.blocked ? '<p class="hint mut">The bot is blocked in that chat, so nothing is being delivered. Send /start to the bot to resume.</p>' : ''}
          <div class="fld"><label for="tg_preview">What alerts show</label>
            <select id="tg_preview">
              <option value="generic"${S.telegram.link.preview !== 'detailed' ? ' selected' : ''}>A generic preview (“You have a new planner alert”)</option>
              <option value="detailed"${S.telegram.link.preview === 'detailed' ? ' selected' : ''}>The title and amount</option>
            </select>
          </div>
          <div class="tools"><button class="btn s" data-act="tg-preview">Save preference</button>
            <button class="btn s r" data-act="tg-unlink">Disconnect</button>${tgChatLink(S.telegram)}</div>`
        : `<p class="mut" style="margin-top:0">Get planner alerts — bills due, renewals, tasks and birthdays — in Telegram. One bot serves every household; only a chat you link here receives your alerts, and disconnecting stops them immediately.</p>
          <p class="mut">1. Press <b>Start chatting</b> to open the planner bot in Telegram.<br>2. Press <b>Connect Telegram</b> below, then send the code to the bot.<br>3. The code works once and expires in 10 minutes.</p>
          <div class="tools">${tgChatLink(S.telegram)}<button class="btn g" data-act="tg-link">Connect Telegram</button></div>
          ${S.telegramCode ? `<div class="alerts" data-stop="1">Send <b>/link ${esc(S.telegramCode)}</b> to the bot. It works once and expires in 10 minutes.</div>` : ''}`}
    <p class="hint mut">Commands: <code>/start</code>, <code>/link CODE</code>, <code>/status</code>, <code>/settings</code>, <code>/unlink</code>, <code>/help</code>.</p>
  </div>
  <div class="card"><h2>Mobile notifications</h2><p class="mut">${esc(pushState)}</p>
    <p class="mut">Bills due, insurance renewals, tasks and birthdays are checked by the server every minute and pushed to every signed-in device the moment they change.</p>
    <button class="btn" data-act="push-on">Enable notifications</button>
    <button class="btn g" data-act="push-test">Send test notification</button>
    <button class="btn g" data-act="push-off">Turn off on this device</button>
    <button class="btn g" data-act="install">Install app</button></div>
  <div class="card"><h2>Calendar subscription</h2>
    <p class="mut" style="margin-top:0">Subscribe once and your calendar keeps itself up to date: open tasks, unpaid bills, insurance renewals and subscription renewals, each with reminders. Works with Google Calendar, Apple Calendar, Outlook, Thunderbird and anything else that accepts a calendar URL. Events update in place, so a paid bill disappears instead of piling up.</p>
    <p class="hint mut" style="margin:0 0 8px">This URL shows only the <b>${esc((S.profiles || []).find((p) => p.id === S.profileId)?.name || 'current')}</b> book. Switch book and open Settings again for that book's own URL.</p>
    ${S.calendarFeed
      ? `<div class="urlbox" aria-label="Calendar feed URL">${esc(S.calendarFeed)}</div>
    <div class="tools"><button class="btn" data-act="ics-copy">Copy URL</button>
      <button class="btn g" data-act="ics">Download .ics once</button>
      <button class="btn g" data-act="ics-rotate">New URL</button></div>`
      : `<p class="mut">Open Settings once you are signed in to get your calendar URL.</p>`}
    <details style="margin-top:10px"><summary class="mut">How to add it in each calendar</summary>
      <ul class="hint mut" style="margin:8px 0 0;padding-left:18px">
        <li><b>Google Calendar</b> (web): Other calendars → + → <i>From URL</i> → paste → Add calendar. The Android and iPhone apps then show it automatically.</li>
        <li><b>Apple Calendar</b> (iPhone/iPad/Mac): Settings → Calendar → Accounts → Add Account → Other → <i>Add Subscribed Calendar</i> → paste.</li>
        <li><b>Outlook</b>: Calendar → Add calendar → <i>Subscribe from web</i> → paste → Import.</li>
        <li><b>Thunderbird / Nextcloud</b>: New calendar → <i>On the network</i> → paste the URL.</li>
      </ul>
      <p class="hint mut">The URL is a secret: anyone who has it can read your event titles, so use <b>New URL</b> if it leaks. It only ever contains the books you are a member of.</p>
    </details></div>
  <h2 class="grouphead">Backup</h2>
  <div class="card"><h2>Backup</h2>
    <p class="mut" style="margin-top:0">Keep a full copy of every book you can open in <b>your own</b> Google Drive.
      The file is versioned JSON with a SHA-256 checksum, and the connection keeps a revocable token for the account you pick —
      the app never sees your drive password, and it can only reach its own private app folder.</p>
    ${(S.cloud || []).map((p) => {
      const runs = (S.backupRuns || []).filter((r) => r.provider === p.id);
      const files = (S.backupFiles || {})[p.id] || null;
      return `      <div class="mrow"><span><b>${esc(p.label)}</b><br>
        ${statusLine(integrationStatus({
          label: p.label || 'Google Drive',
          configured: Boolean(p.configured),
          linked: Boolean(p.linkedAt),
          missing: p.missing || ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
          error: p.error || '',
        }))}</span>
        <b>${p.lastBackupAt ? `Last backup ${relativetimeFrom(p.lastBackupAt)}` : p.configured ? (p.linkedAt ? 'No backup yet' : '—') : '—'}</b>
        <span class="act">
          ${p.linkedAt
            ? `<button class="btn s" data-act="cloud-upload" data-id="${esc(p.id)}">Back up now</button>
               <button class="btn s g" data-act="cloud-list" data-id="${esc(p.id)}">Restore…</button>
               <button class="btn s r" data-act="cloud-unlink" data-id="${esc(p.id)}">Disconnect</button>`
            : p.configured
              ? `<button class="btn s" data-act="cloud-link" data-id="${esc(p.id)}">Connect Google Drive</button>`
              : '<span class="mut" style="font-size:12px">Not set up</span>'}
        </span>
      </div>
      ${files
        ? `<div class="tw" style="margin:6px 0 10px"><table><thead><tr><th>Backup</th><th>Size</th><th>Made</th><th></th></tr></thead><tbody>
            ${files.length
              ? files.map((f) => `<tr><td>${esc(f.name)}</td><td class="mut">${f.bytes ? `${Math.round(f.bytes / 1024)} KB` : '—'}</td>
                  <td class="mut">${f.createdAt ? relativetimeFrom(f.createdAt) : '—'}</td>
                  <td class="act"><button class="btn s g" data-act="cloud-restore" data-provider="${esc(p.id)}" data-file="${esc(f.id)}" data-name="${esc(f.name)}">Restore</button></td></tr>`).join('')
              : '<tr><td colspan="4" class="mut">No backups in that drive yet.</td></tr>'}
          </tbody></table></div>`
        : ''}
      ${runs.length
        ? `<p class="hint mut">Recent runs: ${runs.slice(0, 3).map((r) => `${esc(r.trigger)} ${relativetimeFrom(r.created_at)}`).join(' · ')}</p>`
        : ''}`;
    }).join('')}
    ${(S.cloud || []).some((p) => !p.configured)
      ? `<p class="hint mut"><b>Google setup incomplete (owner action needed)</b> — add
          <code>${esc(
            (S.cloud || [])
              .flatMap((p) => p.missing || [])
              .filter((v, i, a) => a.indexOf(v) === i)
              .join('</code>, <code>'),
          )}</code>.</p>`
      : ''}
    ${S.backupKeyConfigured === false
      ? '<p class="hint mut"><b>Backup key not set (owner action needed: BACKUP_KEY)</b> — without it a refresh token cannot be stored encrypted, so a drive cannot be connected.</p>'
      : ''}

    <h3 style="margin:16px 0 6px;font-size:15px">Automatic backup</h3>
    <div class="mrow"><span>Schedule</span>
      <b>${S.cloudState && S.cloudState.enabled ? `${esc(S.cloudState.frequency)} · keep ${Number(S.cloudState.keep) || 7}` : 'Off'}</b>
      <span class="act"></span>
    </div>
    <div class="tools" style="gap:8px;flex-wrap:wrap;align-items:center">
      <label class="mut" style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="backup_on" ${S.cloudState && S.cloudState.enabled ? 'checked' : ''}> On
      </label>
      <select id="backup_provider" style="max-width:180px">
        ${(S.cloud || []).filter((p) => p.linkedAt).map((p) => `<option value="${esc(p.id)}" ${S.cloudState && S.cloudState.provider === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('') || '<option value="">Connect a drive first</option>'}
      </select>
      <select id="backup_freq" style="max-width:130px">
        <option value="daily" ${S.cloudState && S.cloudState.frequency === 'daily' ? 'selected' : ''}>Daily</option>
        <option value="weekly" ${S.cloudState && S.cloudState.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
      </select>
      <label class="mut" style="display:flex;align-items:center;gap:6px">Keep
        <input id="backup_keep" type="number" min="1" max="60" value="${Number(S.cloudState && S.cloudState.keep) || 7}" style="width:70px">
      </label>
      <button class="btn s" data-act="backup-save">Save</button>
    </div>
    <p class="hint mut">Automatic backup is off unless you turn it on. When it runs, the oldest backups beyond the number you keep are deleted from the app folder.</p>
  </div>
  <div class="card"><h2>Backup &amp; restore</h2>
    <p class="mut">Create an encrypted backup of <b>${esc(S.profile ? S.profile.name : 'this profile')}</b> only. The file is sealed with AES-256-GCM under a passphrase you choose here; the passphrase and the key never reach the server, so neither this app nor anyone running it can read the backup. Store it in Google Drive, on a USB stick, or anywhere else — it stays encrypted.</p>
    <div class="tools"><button class="btn" data-act="backup">Create encrypted backup</button>
    <button class="btn g" data-act="restore-backup">Restore from backup</button></div>
    <p class="hint mut">Restoring validates the file first, shows how many records it holds, asks for confirmation, and merges by id — it never wipes the profile first. A backup only contains the profile it was made from.</p>
  </div>
  <h2 class="grouphead">Data</h2>
  <div class="card"><h2>Documents drive</h2>
    <p class="mut">${(S.files || []).length} file${(S.files || []).length === 1 ? '' : 's'} · ${((S.filesTotal || 0) / 1048576).toFixed(2)} MB used${S.storage === false ? ' · storage is not configured for this site' : ''}. Bills and policy documents you attach are kept here.</p>
    ${(S.files || []).length ? `<div class="tw"><table><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>${S.files.map((f) => `<tr><td><a href="/api/files/${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a></td><td class="mut">${esc(String(f.mime).split('/')[1] || f.mime)}</td><td class="num">${Math.round(Number(f.size) / 1024)} KB</td><td class="mut">${esc(relative(f.created_at))}</td><td class="act"><button class="btn s r" data-act="drive-del" data-id="${esc(f.id)}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">Nothing uploaded yet — attach a bill from the Expenses form.</p>'}</div>
  <div class="card"><h2>My data</h2>
    <p class="mut">A copy of <b>${esc(S.profile ? S.profile.name : 'this book')}</b> only — the book you are looking at, not the other books or another member's data. Both files land in your Downloads folder and open without a network connection.</p>
    <div class="tools" style="flex-wrap:wrap">
      <button class="btn" data-act="backup-plain">Download JSON</button>
      <button class="btn g" data-act="download-csv">Download CSV</button>
    </div>
    <p class="hint mut">JSON keeps every field exactly as stored. CSV puts every record in one sheet with a <code>collection</code> and <code>id</code> column, so it opens in Excel or Sheets.</p>
    <div class="mrow" style="margin-top:12px"><span>Android app</span><b>${S.release && S.release.apkUrl ? `v${esc(S.release.version || '')}` : 'not published'}</b></div>
    ${S.release && S.release.apkUrl
      ? `<a class="btn g" href="${esc(S.release.apkUrl)}" download>Download Android app</a>
         <p class="hint mut" style="word-break:break-all">SHA-256 <code>${esc(S.release.apkSha256 || 'not recorded')}</code></p>`
      : '<p class="hint mut">The owner has not published an APK yet.</p>'}
    <div class="tools" style="margin-top:12px"><button class="btn g" data-act="sample-data">Load sample data</button>
      <button class="btn r" data-act="clear-data">Clear all data</button></div>
    <p class="hint mut" style="margin-top:8px">Clearing removes every contact, bill, expense, policy, task and document for all books. Accounts and settings stay.</p></div>
  <div class="card"><h2>Recent changes</h2><div class="tw"><table><thead><tr><th>Record</th><th>Module</th><th>Action</th><th>When</th></tr></thead><tbody>${activityRows}</tbody></table></div></div>
  <h2 class="grouphead">About</h2>
  <div class="card"><h2>About</h2>
    <div class="mrow"><span>Version</span><b>${esc(S.release && S.release.version ? S.release.version : S.account.version || '')}</b></div>
    <div class="mrow"><span>Sync</span><b>${S.sync === 'live' ? 'Connected' : 'Reconnecting'}</b></div>
    <p class="mut">Family Finance Planner · ${(S.db.contacts || []).length.toLocaleString('en-IN')} contacts, ${(S.db.payments || []).length} bills, ${(S.db.loans || []).length} loans, ${(S.db.insurance || []).length} policies, ${(S.db.diary || []).length} diary entries. Signed in as ${esc(S.me.name || 'family')}.</p>
    <div class="tools"><button class="btn g" data-act="push-settings">Notification settings</button>
      <button class="btn g" data-act="help">Help</button></div></div>
`;
}

function relative(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} h ago`;
  return `${Math.round(diff / 86400000)} d ago`;
}

function relativetimeFrom(ts) {
  return esc(relative(ts));
}

/* ------------------------------------------------------------------ forms */

export function formHtml(collection, record, isNew) {
  const def = COLLECTIONS[collection];
  let html = `<div class="modal" data-act="close"><div class="box" data-stop="1"><h2 style="margin:0 0 10px">${isNew ? 'Add' : 'Edit'} - ${esc(def.label)}</h2><form id="frm">`;
  def.fields.forEach((f) => {
    if (f.k === 'id' && def.autoId) return;
    const value = record[f.k] == null ? '' : record[f.k];
    const id = `f_${f.k}`;
    html += `<div class="fld"><label for="${id}">${esc(f.l)}</label>`;
    if (f.t === 'select') {
      html += `<select id="${id}">${f.o.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (f.t === 'area') {
      html += `<textarea id="${id}" rows="3">${esc(value)}</textarea>`;
    } else if (f.t === 'date') {
      html += `<input id="${id}" type="date" value="${esc(/^\d{4}-\d{2}-\d{2}/.test(value) ? String(value).slice(0, 10) : '')}">`;
    } else if (f.t === 'file') {
      html += `<input id="${id}" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-file-field="1"${value ? ` data-file-id="${esc(value)}"` : ''}>
        <div class="filemeta mut" id="filelabel">${value ? 'Attached document' : 'No file attached (max 8 MB)'}</div>
        ${collection === 'expenses' ? '<button type="button" class="btn s g" data-act="scan">📷 Scan bill</button>' : ''}`;
    } else if (f.t === 'money' || f.t === 'pct') {
      html += `<input id="${id}" type="number" step="any" value="${esc(value)}"${f.t === 'pct' ? ' placeholder="0.085 = 8.5%"' : ''}>`;
    } else {
      html += `<input id="${id}" type="${f.t === 'tel' ? 'tel' : 'text'}" value="${esc(value)}">`;
    }
    html += '</div>';
  });
  html += `<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn g" data-act="close">Cancel</button><button class="btn" style="background:${def.dark}">Save</button></div></form></div></div>`;
  return html;
}

/* ------------------------------------------------------------- quick add */

/** The two things the + button does, and nothing else. */
export function addSheetHtml() {
  const book = S.profile ? esc(S.profile.name) : 'this book';
  return `<div class="modal" data-act="close"><div class="box" data-stop="1" style="max-width:420px">
    <h2 style="margin:0 0 4px">Add to ${book}</h2>
    <p class="mut" style="margin:0 0 12px">One entry by hand, or a CSV/Excel file.</p>
    <button class="btn wide" data-act="addone" style="margin-bottom:8px">Add one entry</button>
    <button class="btn g wide" data-act="addimport">Import CSV or Excel</button>
    <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn g s" data-act="close">Cancel</button></div>
  </div></div>`;
}

/** A short entry form: amount, date, category, note, book. */
export function quickEntryHtml() {
  const books = (S.profiles || []).filter((p) => p.role !== 'Viewer');
  const options = (books.length ? books : S.profiles || [])
    .map((p) => `<option value="${esc(p.id)}"${p.id === S.profileId ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  return `<div class="modal" data-act="close"><div class="box" data-stop="1">
    <h2 style="margin:0 0 10px">Add one entry</h2><form id="qfrm">
      <div class="fld"><label for="q_amount">Amount</label><input id="q_amount" type="number" step="any" inputmode="decimal" placeholder="0"></div>
      <div class="fld"><label for="q_date">Date</label><input id="q_date" type="date" value="${esc(iso(today()))}"></div>
      <div class="fld"><label for="q_cat">Category</label><input id="q_cat" type="text" placeholder="Groceries"></div>
      <div class="fld"><label for="q_note">Note</label><input id="q_note" type="text" placeholder="Optional"></div>
      <div class="fld"><label for="q_book">Book</label><select id="q_book">${options}</select></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn g" data-act="close">Cancel</button><button class="btn" style="background:${COLLECTIONS.expenses.dark}">Save</button></div>
    </form></div></div>`;
}

/* ---------------------------------------------------------------- auth ui */

export function authShell(html) {
  return `<div class="auth"><div class="authcard">
    <div class="brand"><span class="logo">₹</span><div><h1>Family Finance Planner</h1><div class="mut">One household, every device, always in sync</div></div></div>
    ${html}</div><div class="authfoot mut">Private household data · secured with a family PIN and signed sessions</div></div>`;
}

export function lockHtml(message = '') {
  return `<div class="lockwrap"><div class="lockbox">
    <div class="brand"><span class="logo">₹</span><div><h1>Family Finance Planner</h1><div class="mut">Locked after inactivity</div></div></div>
    <h2>Unlock to continue</h2>
    <p>Your data was cleared from this screen while it was locked.</p>
    <form id="lockfrm"><input id="lockpin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" placeholder="••••" aria-label="PIN">
      <button class="btn">Unlock</button></form>
    <div class="lockerr" id="lockerr">${esc(message)}</div>
    <p class="authswitch"><button class="linkbtn" data-act="lock-password">Use email and password instead</button></p>
    <form id="lockpwfrm" style="display:none">
      <div class="fld"><label for="lockemail">Email</label><input id="lockemail" type="email" autocomplete="username"></div>
      <div class="fld"><label for="lockpass">Password</label><input id="lockpass" type="password" autocomplete="current-password"></div>
      <button class="btn">Unlock</button>
    </form></div></div>`;
}

function socialButtonsHtml() {
  const providers = (S.authProviders || []).filter((p) => p.configured);
  if (!providers.length) return '';
  return `<div class="divider"><span>or continue with</span></div>
    <div class="tools" style="justify-content:center;flex-wrap:wrap">
      ${providers
        .map((p) => {
          const label = p.id === 'google' ? 'Continue with Google' : `Continue with ${p.label}`;
          return `<button type="button" class="btn g" data-act="oauth" data-id="${esc(p.id)}">${esc(label)}</button>`;
        })
        .join('')}
    </div>`;
}

export function loginFormHtml(message = '') {
  const pinMode = S.authMethod === 'pin';
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <div class="seg authseg">
      <button type="button" class="${pinMode ? '' : 'on'}" data-act="auth-method" data-id="email">Email &amp; password</button>
      <button type="button" class="${pinMode ? 'on' : ''}" data-act="auth-method" data-id="pin">Family PIN</button>
    </div>
    ${pinMode
      ? `<form id="pinfrm">
          <div class="fld"><label for="pin">Family PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" placeholder="••••" autofocus></div>
          <button class="btn wide" style="background:var(--accent);color:var(--accent-ink)">Unlock</button>
        </form>`
      : `<form id="loginfrm">
          <div class="fld"><label for="email">Email</label><input id="email" type="email" autocomplete="username" placeholder="you@example.com" value="${esc(S.authEmail || '')}" autofocus></div>
          <div class="fld"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" placeholder="••••••••"></div>
          <button class="btn wide" style="background:var(--accent);color:var(--accent-ink)">Sign in</button>
        </form>`}
    <p class="authswitch"><button class="linkbtn" data-act="forgot">Forgot password or PIN?</button></p>
    ${socialButtonsHtml()}
    <p class="authswitch">New here? <button class="linkbtn" data-act="signup">Create an account</button></p>
    ${S.configured === false ? '<p class="authswitch mut">Or <button class="linkbtn" data-act="setup">set up a household PIN</button> for the whole family.</p>' : ''}`;
}

export function forgotFormHtml(message = '') {
  if (!S.authEmailSent) {
    return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
      ${S.emailEnabled
        ? '<p class="mut" style="margin-top:0">Enter the email on your account and we will send a six-digit code.</p>'
        : '<p class="mut" style="margin-top:0">This deployment has no email sender yet, so a code cannot be sent. Use your recovery code below, or sign in with the family PIN and then set a password in Settings.</p>'}
      <form id="otpfrm">
        <div class="fld"><label for="fp_email">Email</label><input id="fp_email" type="email" autocomplete="username" placeholder="you@example.com" autofocus required></div>
        <button class="btn wide" style="background:var(--accent);color:var(--accent-ink)">Send code</button>
      </form>
      <details class="authmore"><summary>I have a recovery code</summary>
        <form id="recoverfrm" style="margin-top:8px">
          <div class="fld"><label for="fp_code">Recovery code</label><input id="fp_code" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX"></div>
          <div class="fld"><label for="fp_pin">New PIN</label><input id="fp_pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" placeholder="4-12 digits"></div>
          <button class="btn g wide">Reset PIN</button>
        </form>
      </details>
      <p class="authswitch"><button class="linkbtn" data-act="tosignin">Back to sign in</button></p>`;
  }
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <p class="mut" style="margin-top:0">If <b>${esc(S.authEmail || 'that address')}</b> has an account, a code is on its way.
      It expires in 10 minutes.</p>
    <form id="otpresetfrm">
      <div class="fld"><label for="fp_otp">Six-digit code</label><input id="fp_otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" autofocus required></div>
      <div class="fld"><label for="fp_newpass">New password</label><input id="fp_newpass" type="password" autocomplete="new-password" placeholder="8+ characters, letters and numbers" required></div>
      <button class="btn wide" style="background:var(--accent);color:var(--accent-ink)">Reset password</button>
    </form>
    <p class="authswitch"><button class="linkbtn" data-act="forgot">Use a different email</button></p>`;
}

/** Second factor step shown after a correct password or PIN. */
export function twoFactorFormHtml(message = '') {
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <form id="totploginfrm">
      <p class="mut" style="margin-top:0">Two-factor is on for this account. Open your authenticator app and
        enter the current six digits.</p>
      <div class="fld"><label for="login_code">Authenticator code</label><input id="login_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required></div>
      <button class="btn wide">Verify and continue</button>
    </form>
    <p class="authswitch"><button class="linkbtn" data-act="tosignin">Start over</button></p>`;
}

export function signupFormHtml(message = '') {
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <form id="signupfrm">
      <div class="fld"><label for="su_name">Name (optional)</label><input id="su_name" maxlength="60" placeholder="Your name"></div>
      <div class="fld"><label for="su_email">Email</label><input id="su_email" type="email" autocomplete="username" placeholder="you@example.com" required></div>
      <div class="fld"><label for="su_password">Password</label><input id="su_password" type="password" autocomplete="new-password" placeholder="8+ characters, letters and numbers" required></div>
      <button class="btn wide" style="background:var(--accent);color:var(--accent-ink)">Create account</button>
    </form>
    <details class="authmore"><summary>I have an invite code</summary>
      <div class="fld" style="margin-top:8px"><label for="su_code">Invite code</label><input id="su_code" maxlength="12" autocapitalize="characters" placeholder="ABCD1234"></div>
      <p class="mut" style="margin:0">Joining someone's household shares their family book with you.</p>
    </details>
    ${socialButtonsHtml()}
    <p class="authswitch"><button class="linkbtn" data-act="tosignin">Back to sign in</button></p>`;
}

export function setupFormHtml(message = '') {
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <form id="setupfrm"><div class="fld"><label for="household">Household name</label><input id="household" value="Family Planner" maxlength="60"></div>
    <div class="fld"><label for="pin">Choose a family PIN (4-12 digits)</label><input id="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" required></div>
    <div class="fld"><label for="pin2">Repeat PIN</label><input id="pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" required></div>
    <button class="btn wide" style="background:var(--accent);color:var(--accent-ink)">Create planner</button></form>
    <p class="mut">This PIN protects every device that signs in. The starter data set is loaded once, then you can edit or import your own contacts.</p>
    <p class="authswitch"><button class="linkbtn" data-act="tosignin">Use email and password instead</button></p>`;
}

/* --------------------------------------------------------- notifications */

export function notificationsPanelHtml() {
  const items = (S.notifications || []).slice(0, 20);
  return `<div class="bellpanel" data-stop="1">
    <div class="bellhead"><b>Notifications</b><button class="btn s g" data-act="note-read">Mark all read</button></div>
    <div class="bellbody">${items.length
      ? items.map((n) => `<div class="noterow${n.read_at ? '' : ' unread'} lvl-${esc(n.level || 'info')}"><div class="nrhead"><b>${esc(n.title)}</b></div><div class="mut">${esc(n.body)}</div><div class="nrmeta"><span class="mut small">${esc(relative(n.created_at))}</span></div></div>`).join('')
      : '<div class="mut" style="padding:12px">No notifications yet.</div>'}</div>
    <div class="bellfoot"><button class="btn g" data-act="push-settings">Notification settings</button></div></div>`;
}

/* -------------------------------------------------------- family members */

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

function memberCard(m) {
  const bday = bdayNext(m);
  return `<div class="member">
    <div class="memberhead"><span class="avatar big">${esc(initials(m.name))}</span>
      <div><div class="mname">${esc(m.name)}</div>
        <div class="mchips"><span class="chip">${esc(m.relation || 'Family')}</span><span class="chip alt">${esc(m.role || 'Adult')}</span>${m.ice === 'Yes' ? '<span class="chip ice">ICE</span>' : ''}</div>
      </div>
    </div>
    <div class="mrow"><span>Mobile</span><b>${m.mobile ? `<a href="tel:${esc(String(m.mobile).replace(/\s/g, ''))}">${esc(m.mobile)}</a>` : '-'}</b></div>
    <div class="mrow"><span>Email</span><b>${esc(m.email || '-')}</b></div>
    <div class="mrow"><span>Birthday</span><b>${m.bday ? `${esc(dfmt(m.bday))}${bday ? ` · in ${bday.days}d` : ''}` : '-'}</b></div>
    <div class="mrow"><span>Occupation</span><b>${esc(m.occupation || '-')}</b></div>
    ${m.notes ? `<div class="mnotes mut">${esc(m.notes)}</div>` : ''}
    <div class="memberlinks">
      ${m.mobile ? `<a class="btn s g" href="tel:${esc(String(m.mobile).replace(/\s/g, ''))}">Call</a>` : ''}
      <button class="btn s g" data-act="edit" data-ek="family" data-id="${esc(m.id)}">Edit</button>
      <button class="btn s r" data-act="del" data-ek="family" data-id="${esc(m.id)}">✕</button>
    </div>
  </div>`;
}

export function subscriptionsMonthly() {
  return (S.db.subscriptions || [])
    .filter((s) => s.status === 'Active')
    .reduce((total, s) => {
      const amount = num(s.amount);
      if (s.cycle === 'Monthly') return total + amount;
      if (s.cycle === 'Quarterly') return total + amount / 3;
      if (s.cycle === 'Yearly') return total + amount / 12;
      return total;
    }, 0);
}

export function subscriptionsView() {
  const subs = S.db.subscriptions || [];
  const active = subs.filter((s) => s.status === 'Active');
  const monthly = subscriptionsMonthly();
  const upcoming = active
    .filter((s) => s.nextDue)
    .sort((a, b) => String(a.nextDue).localeCompare(String(b.nextDue)))
    .slice(0, 6);
  const soonest = upcoming[0];
  const cards = [
    ['ACTIVE SUBSCRIPTIONS', active.length, '#7C3AED'],
    ['MONTHLY COST', money(monthly), '#B91C1C'],
    ['YEARLY COST', money(monthly * 12), '#6D28D9'],
    ['NEXT RENEWAL', soonest ? `${daysTo(soonest.nextDue)}d · ${esc(soonest.service)}` : '-', '#0F766E'],
  ];
  return `<div class="bar" style="background:#7C3AED">SUBSCRIPTION OVERVIEW</div>
    <div class="grid kpis">${cards.map((c) => `<div class="kpi" style="--c:${c[2]}"><div class="l">${c[0]}</div><div class="v">${c[1]}</div></div>`).join('')}</div>
    ${watch('RENEWING SOON', '#7C3AED', '#EDE9FE', ['Service', 'Plan', 'Amount', 'Cycle', 'Next renewal', 'In (days)'], upcoming.map((s) => [esc(s.service), esc(s.plan), money(s.amount), esc(s.cycle), dfmt(s.nextDue), daysTo(s.nextDue)]))}
    <div class="card" style="margin-top:12px"><h2>All subscriptions</h2>${tableView('subscriptions')}</div>`;
}

export function familyView() {
  const members = S.db.family || [];
  return `<div class="card"><div class="tools"><h2 style="margin:0">Family members</h2>
      <button class="btn" style="background:${COLLECTIONS.family.dark}" data-act="add" data-ek="family">+ Add member</button>
      <button class="btn g" data-act="csv" data-ek="family">Export</button>
      <button class="btn g" data-act="template" data-ek="family">Template</button>
      <button class="btn g" data-act="impcsv" data-ek="family">Import</button>
      <span class="mut right">${members.length} member${members.length === 1 ? '' : 's'}</span></div>
      <p class="mut" style="margin:0">Add each family member once — they then appear in alerts, birthdays and insurance nominees.</p></div>
    <div class="members">${members.map(memberCard).join('') || '<div class="card mut">No family members yet — add the first one with “+ Add member”.</div>'}</div>`;
}
