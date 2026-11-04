// Rendering. Pure functions that read S and return HTML strings; app.js wires events.

import { COLLECTIONS } from './entities.js';
import { S } from './state.js';
import { billAlert, bdayNext, insStatus, kpis, selfC, sum } from './analytics.js';
import { digits, dfmt, esc, daysTo, money, num, stat } from './format.js';
import {
  googleCalendarLink,
  notificationMessage,
  recordMessage,
  smsLink,
  whatsappLink,
} from './exporters.js';

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
      { v: row.status === 'Completed' ? 'No alert needed' : `Reminder to ${S.settings.mobile}`, badge: true },
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
  html += `<button class="btn" style="background:${def.dark}" data-act="add" data-ek="${collection}">+ Add</button><button class="btn g" data-act="csv" data-ek="${collection}">Export</button><button class="btn g" data-act="template" data-ek="${collection}">Template</button><button class="btn g" data-act="impcsv" data-ek="${collection}">Import CSV</button>`;
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
      const wa = whatsappLink(r.phone || r.alert || S.settings.mobile, recordMessage(collection, r));
      if (wa) html += `<a class="btn s wa" target="_blank" rel="noopener" href="${esc(wa)}">WA</a> `;
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
  const pushState = !('Notification' in window)
    ? 'This browser cannot show notifications.'
    : Notification.permission === 'granted' && S.pushEnabled
      ? 'Notifications are enabled on this device.'
      : Notification.permission === 'denied'
        ? 'Notifications are blocked in the browser settings for this site.'
        : 'Notifications are not enabled yet.';

  return `<div class="card"><h2>Your account</h2>
      <div class="mrow"><span>Signed in as</span><b>${esc(S.me.name || '-')}</b></div>
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
    <div class="fld"><label>Household name</label><input id="s_household" value="${esc(S.settings.household || '')}"></div>
    <div class="fld"><label>Linked mobile number</label><input id="s_mobile" value="${esc(S.settings.mobile || '')}"></div>
    <div class="fld"><label>Daily alert time (used for calendar events)</label><input id="s_time" type="time" value="${esc(S.settings.alertTime || '06:00')}"></div>
    <div class="fld"><label>Alert channel</label><select id="s_channel">${['Push + in-app', 'WhatsApp', 'SMS', 'All channels'].map((c) => `<option${c === (S.settings.channel || 'Push + in-app') ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
    <p class="mut">WhatsApp and SMS open your own messenger with the alert text ready to send — nothing is sent automatically.</p>
    <button class="btn" data-act="saveset">Save settings</button></div>

  <div class="card"><h2>Mobile notifications</h2><p class="mut">${esc(pushState)}</p>
    <p class="mut">Bills due, insurance renewals, tasks and birthdays are checked by the server every minute and pushed to every signed-in device the moment they change.</p>
    <button class="btn" data-act="push-on">Enable notifications</button>
    <button class="btn g" data-act="push-test">Send test notification</button>
    <button class="btn g" data-act="push-off">Turn off on this device</button>
    <button class="btn g" data-act="install">Install app</button>
    ${S.release && S.release.apkUrl ? `<a class="btn g" href="${esc(S.release.apkUrl)}" target="_blank" rel="noopener">Android APK ${esc(S.release.version || '')}</a>` : ''}</div>

  <div class="card"><h2>Security</h2>
    <div class="fld"><label>Current PIN</label><input id="p_cur" type="password" inputmode="numeric" autocomplete="current-password"></div>
    <div class="fld"><label>New PIN (4-12 digits)</label><input id="p_new" type="password" inputmode="numeric" autocomplete="new-password"></div>
    <button class="btn" data-act="change-pin">Change PIN</button>
    <div class="tw" style="margin-top:12px"><table><thead><tr><th>Device</th><th>Signed in</th><th>Status</th></tr></thead><tbody>${sessionRows}</tbody></table></div>
    <p style="margin-top:10px"><button class="btn r" data-act="revoke-sessions">Sign out all devices</button>
    <button class="btn g" data-act="logout">Sign out here</button></p></div>

  <div class="card"><h2>AI tools</h2>
    <p class="mut">Connect any OpenAI-compatible provider (OpenAI, Z.ai GLM, Groq, OpenRouter). The key is stored on the server, never sent to the browser, and only used when you scan a bill.</p>
    ${(S.aiConnections || []).length ? `<div class="tw"><table><thead><tr><th>Provider</th><th>Model</th><th>Base URL</th><th></th></tr></thead><tbody>${S.aiConnections.map((c) => `<tr><td>${esc(c.provider)}</td><td>${esc(c.model)}</td><td class="mut">${esc(c.base_url)}</td><td class="act"><button class="btn s g" data-act="ai-test" data-id="${esc(c.id)}">Test</button> <button class="btn s r" data-act="ai-del" data-id="${esc(c.id)}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No AI tool connected yet — bill scanning needs one.</p>'}
    <div class="fld" style="margin-top:10px"><label>Provider name</label><input id="ai_provider" placeholder="OpenAI / Z.ai / Groq"></div>
    <div class="fld"><label>Base URL</label><input id="ai_url" placeholder="https://api.openai.com/v1"></div>
    <div class="fld"><label>Model with image support</label><input id="ai_model" placeholder="gpt-4o-mini / glm-4v"></div>
    <div class="fld"><label>API key</label><input id="ai_key" type="password" autocomplete="off" placeholder="Stored on the server"></div>
    <button class="btn" data-act="ai-add">Connect AI tool</button></div>

  <div class="card"><h2>Documents drive</h2>
    <p class="mut">${(S.files || []).length} file${(S.files || []).length === 1 ? '' : 's'} · ${((S.filesTotal || 0) / 1048576).toFixed(2)} MB used${S.storage === false ? ' · storage is not configured for this site' : ''}. Bills and policy documents you attach are kept here.</p>
    ${(S.files || []).length ? `<div class="tw"><table><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>${S.files.map((f) => `<tr><td><a href="/api/files/${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a></td><td class="mut">${esc(String(f.mime).split('/')[1] || f.mime)}</td><td class="num">${Math.round(Number(f.size) / 1024)} KB</td><td class="mut">${esc(relative(f.created_at))}</td><td class="act"><button class="btn s r" data-act="drive-del" data-id="${esc(f.id)}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">Nothing uploaded yet — attach a bill from the Expenses form.</p>'}</div>

  <div class="card"><h2>Calendar alerts</h2><p class="mut">Creates a calendar file with every uncompleted task, unpaid bill, insurance renewal and birthday, each with reminders (tasks: 1 day + at time; bills: 3 days, 1 day, at time; renewals: 30/15/7/1 days). Import it once into Google Calendar and re-import to update the same events. The 📅 button on each row adds a single event.</p>
    <button class="btn" data-act="ics">Download calendar alerts (.ics)</button></div>

  <div class="card"><h2>Backup &amp; restore</h2>
    <p class="mut">Create an encrypted backup of <b>${esc(S.profile ? S.profile.name : 'this profile')}</b> only. The file is sealed with AES-256-GCM under a passphrase you choose here; the passphrase and the key never reach the server, so neither this app nor anyone running it can read the backup. Store it in Google Drive, OneDrive or anywhere else — it stays encrypted.</p>
    <div class="tools"><button class="btn" data-act="backup">Create encrypted backup</button>
    <button class="btn g" data-act="restore-backup">Restore from backup</button></div>
    <p class="hint mut">Restoring validates the file first, shows how many records it holds, asks for confirmation, and merges by id — it never wipes the profile first. A backup only contains the profile it was made from.</p>
  </div>

  <div class="card"><h2>Data</h2><p class="mut">Everything is stored in the planner database and synced live to every device that signs in. Export a plain copy any time.</p>
    <button class="btn g" data-act="backup-plain">Download plain JSON</button>
    <button class="btn g" data-act="sample-data">Load sample data</button>
    <button class="btn r" data-act="clear-data">Clear all data</button>
    <p class="hint mut" style="margin-top:8px">Clearing removes every contact, bill, expense, policy, task and document for all books. Accounts and settings stay.</p></div>

  <div class="card"><h2>Security audit</h2>
    <p class="mut">Sign-ins, failed sign-ins, profile switches, sharing and role changes, exports and deletions, newest first. No financial values or keys are recorded here.</p>
    <div class="tw"><table><thead><tr><th>When</th><th>Action</th><th>Who</th><th>Target</th></tr></thead><tbody>${(S.audit || [])
      .map(
        (e) => `<tr><td class="mut">${esc(relative(e.ts))}</td><td>${esc(e.action)}</td><td>${esc(e.actor_name || 'system')}</td><td class="mut">${esc(e.target || e.detail || '')}</td></tr>`,
      )
      .join('') || '<tr><td colspan="4" class="mut">No audit events yet</td></tr>'}</tbody></table></div>
  </div>

  <div class="card"><h2>Recent changes</h2><div class="tw"><table><thead><tr><th>Record</th><th>Module</th><th>Action</th><th>When</th></tr></thead><tbody>${activityRows}</tbody></table></div></div>

  <div class="card"><h2>About</h2><p class="mut">Family Finance Planner · ${(S.db.contacts || []).length.toLocaleString('en-IN')} contacts, ${(S.db.payments || []).length} bills, ${(S.db.loans || []).length} loans, ${(S.db.insurance || []).length} policies, ${(S.db.diary || []).length} diary entries. Signed in as ${esc(S.me.name || 'family')}. Realtime sync is ${S.sync === 'live' ? 'connected' : 'reconnecting'}.</p></div>`;
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

export function loginFormHtml(message = '') {
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <form id="loginfrm">
      <div class="fld"><label for="email">Email</label><input id="email" type="email" autocomplete="username" placeholder="you@example.com"></div>
      <div class="fld"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" placeholder="••••••••"></div>
      <button class="btn wide">Sign in</button>
    </form>
    <div class="divider"><span>or unlock with the family PIN</span></div>
    <form id="pinfrm"><div class="fld"><label for="pin">Family PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" placeholder="••••"></div>
      <button class="btn g wide">Unlock with PIN</button></form>
    <p class="authswitch"><button class="linkbtn" data-act="signup">Create a member account</button></p>`;
}

export function signupFormHtml(message = '') {
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <form id="signupfrm">
      <div class="fld"><label for="su_name">Your name</label><input id="su_name" maxlength="60" placeholder="Name"></div>
      <div class="fld"><label for="su_email">Email</label><input id="su_email" type="email" autocomplete="username" placeholder="you@example.com" required></div>
      <div class="fld"><label for="su_password">Password</label><input id="su_password" type="password" autocomplete="new-password" placeholder="At least 8 characters, letters and numbers" required></div>
      <div class="fld"><label for="su_password2">Repeat password</label><input id="su_password2" type="password" autocomplete="new-password" required></div>
      <div class="fld"><label for="su_code">Invite code (optional)</label><input id="su_code" maxlength="12" autocapitalize="characters" placeholder="Leave blank to start your own planner"></div>
      <p class="mut" style="margin:-4px 0 8px">Have a code from a household owner? Enter it to share their family book. No code? You get a private planner of your own.</p>
      <button class="btn wide">Create account</button>
    </form>
    <p class="authswitch"><button class="linkbtn" data-act="tosignin">Back to sign in</button></p>`;
}

export function setupFormHtml(message = '') {
  return `${message ? `<div class="alerts">${esc(message)}</div>` : ''}
    <form id="setupfrm"><div class="fld"><label for="household">Household name</label><input id="household" value="Family Planner" maxlength="60"></div>
    <div class="fld"><label for="pin">Choose a family PIN (4-12 digits)</label><input id="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" required></div>
    <div class="fld"><label for="pin2">Repeat PIN</label><input id="pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" required></div>
    <button class="btn wide">Create planner</button></form>
    <p class="mut">This PIN protects every device that signs in. The starter data set is loaded once, then you can edit or import your own contacts.</p>`;
}

/* --------------------------------------------------------- notifications */

export function notificationsPanelHtml() {
  const items = (S.notifications || []).slice(0, 20);
  return `<div class="bellpanel" data-stop="1">
    <div class="bellhead"><b>Notifications</b><button class="btn s g" data-act="note-read">Mark all read</button></div>
    <div class="bellbody">${items.length
      ? items.map((n) => {
          const text = notificationMessage(n);
          const wa = whatsappLink(S.settings.mobile, text);
          return `<div class="note ${n.read_at ? '' : 'unread'} lvl-${esc(n.level || 'info')}"><div class="ntitle">${esc(n.title)}</div><div class="nbody">${esc(n.body)}</div><div class="ntime mut">${esc(relative(n.created_at))}</div><div class="noteacts">${wa ? `<a class="btn s wa" target="_blank" rel="noopener" href="${esc(wa)}">WhatsApp</a>` : ''}<a class="btn s g" href="${esc(smsLink(S.settings.mobile, text))}">SMS</a></div></div>`;
        }).join('')
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
  const wa = whatsappLink(m.mobile, recordMessage('family', m));
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
      ${wa ? `<a class="btn s wa" target="_blank" rel="noopener" href="${esc(wa)}">WhatsApp</a>` : ''}
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
      <button class="btn g" data-act="impcsv" data-ek="family">Import CSV</button>
      <span class="mut right">${members.length} member${members.length === 1 ? '' : 's'}</span></div>
      <p class="mut" style="margin:0">Add each family member once — they then appear in alerts, birthdays and insurance nominees.</p></div>
    <div class="members">${members.map(memberCard).join('') || '<div class="card mut">No family members yet — add the first one with “+ Add member”.</div>'}</div>`;
}
