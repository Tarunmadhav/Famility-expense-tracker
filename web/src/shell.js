// Application chrome: sidebar, top bar, mobile tab bar and the profile switcher.
// Kept separate from the module views so the layout can change without touching
// tables, forms or the settings screens.

import { S } from './state.js';
import { esc } from './format.js';

export const KIND = {
  family: { label: 'Family', icon: '🏠', accent: '#0f766e' },
  office: { label: 'Office', icon: '💼', accent: '#334155' },
  personal: { label: 'Personal', icon: '👤', accent: '#6d28d9' },
};

/** Sidebar groups per profile kind. Office gets business vocabulary, not family. */
export const NAV = {
  family: [
    { group: 'Overview', items: [['dashboard', 'Dashboard', '◧'], ['reports', 'Reports', '▤']] },
    {
      group: 'Household',
      items: [
        ['family', 'Family', '👥'],
        ['contacts', 'Contacts', '☎'],
        ['diary', 'Tasks & diary', '✓'],
      ],
    },
    {
      group: 'Money',
      items: [
        ['expenses', 'Expenses', '₹'],
        ['budget', 'Budgets', '▦'],
        ['payments', 'Bills', '🧾'],
        ['subscriptions', 'Subscriptions', '↻'],
        ['loans', 'Loans', '🏦'],
        ['insurance', 'Insurance', '🛡'],
      ],
    },
    { group: 'System', items: [['notifications', 'Notifications', '🔔'], ['settings', 'Settings', '⚙']] },
  ],
  office: [
    { group: 'Workspace', items: [['dashboard', 'Overview', '◧'], ['reports', 'Reports', '▤']] },
    {
      group: 'Business',
      items: [
        ['expenses', 'Expenditure', '₹'],
        ['diary', 'Tasks', '✓'],
        ['contacts', 'Directory', '☎'],
        ['budget', 'Budgets', '▦'],
      ],
    },
    { group: 'System', items: [['notifications', 'Notifications', '🔔'], ['settings', 'Settings', '⚙']] },
  ],
  personal: [
    { group: 'Overview', items: [['dashboard', 'Dashboard', '◧'], ['reports', 'Reports', '▤']] },
    {
      group: 'My money',
      items: [
        ['expenses', 'Spending', '₹'],
        ['budget', 'Budgets', '▦'],
        ['payments', 'Bills', '🧾'],
        ['subscriptions', 'Subscriptions', '↻'],
      ],
    },
    {
      group: 'My life',
      items: [
        ['diary', 'Tasks', '✓'],
        ['contacts', 'Contacts', '☎'],
        ['insurance', 'Insurance', '🛡'],
        ['loans', 'Loans', '🏦'],
      ],
    },
    { group: 'System', items: [['notifications', 'Notifications', '🔔'], ['settings', 'Settings', '⚙']] },
  ],
};

export function kindOf(id) {
  const profile = (S.profiles || []).find((p) => p.id === id);
  if (profile) return profile.kind;
  const raw = String(id || '');
  if (raw.startsWith('o:')) return 'office';
  if (raw.startsWith('u:')) return 'personal';
  return 'family';
}

export function currentKind() {
  return S.profile ? S.profile.kind : kindOf(S.profileId);
}

export function navFor(kind = currentKind()) {
  return NAV[kind] || NAV.family;
}

export function profileSwitcherHtml() {
  const profiles = S.profiles || [];
  if (!profiles.length) return '';
  return `<div class="pswitch" role="group" aria-label="Switch profile">
    ${profiles
      .map((p) => {
        const meta = KIND[p.kind] || KIND.family;
        const on = p.id === S.profileId;
        return `<button class="pchip${on ? ' on' : ''}" data-act="profile" data-profile="${esc(p.id)}"
            aria-pressed="${on}" style="--c:${meta.accent}">
            <span class="picon">${meta.icon}</span>
            <span class="pmeta"><b>${esc(p.name)}</b><small>${esc(p.role)}${p.unread ? ` · ${p.unread} new` : ''}</small></span>
          </button>`;
      })
      .join('')}
  </div>`;
}

export function sidebarHtml() {
  const kind = currentKind();
  const nav = navFor(kind);
  return `<aside class="sidebar${S.drawer ? ' open' : ''}" id="sidebar">
    <div class="brandrow">
      <span class="logo">₹</span>
      <div class="brandtext"><b>Finance Planner</b><small>v${esc(S.version || '2.1.0')}</small></div>
      <button class="iconbtn drawer-close" data-act="drawer" aria-label="Close menu">✕</button>
    </div>
    ${profileSwitcherHtml()}
    <nav class="snav" aria-label="Sections">
      ${nav
        .map(
          (section) => `<div class="ngroup"><span class="nglabel">${esc(section.group)}</span>
            ${section.items
              .map(
                ([id, label, glyph]) =>
                  `<button class="nitem${S.tab === id ? ' on' : ''}" data-tab="${id}"${
                    S.tab === id ? ' aria-current="page"' : ''
                  }><span class="glyph" aria-hidden="true">${glyph}</span>${esc(label)}${
                    id === 'notifications' && totalUnread() ? `<span class="nbadge">${totalUnread()}</span>` : ''
                  }</button>`,
              )
              .join('')}
          </div>`,
        )
        .join('')}
    </nav>
    <div class="sfoot">
      <button class="nitem" data-act="theme"><span class="glyph">${S.theme === 'dark' ? '☀' : '☾'}</span>${S.theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
      <button class="nitem" data-act="lock"><span class="glyph">🔒</span>Lock now</button>
      <button class="nitem" data-act="logout"><span class="glyph">↪</span>Sign out</button>
    </div>
  </aside>
  ${S.drawer ? '<div class="scrim" data-act="drawer" aria-hidden="true"></div>' : ''}`;
}

export function totalUnread() {
  return (S.profiles || []).reduce((n, p) => n + (p.unread || 0), 0);
}

export function topbarHtml(title, subtitle) {
  const initials = String(S.me.name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
  return `<header class="topbar">
    <button class="iconbtn only-mobile" data-act="drawer" aria-label="Open menu">☰</button>
    <div class="tb-title"><h1>${esc(title)}</h1><div class="tbsub">${subtitle}</div></div>
    <div class="tb-actions">
      <span class="sync ${S.sync}" id="sync" title="${S.sync === 'live' ? 'Live sync connected' : 'Reconnecting'}"><i></i><span class="synctext">${S.sync === 'live' ? 'Live' : 'Sync'}</span></span>
      <div class="gsearch">
        <input id="gsearch" type="search" placeholder="Search this profile" value="${esc(S.q[S.tab] || '')}" aria-label="Search current profile">
      </div>
      <button class="iconbtn bellbtn" data-act="bell" aria-label="Notifications">🔔${
        totalUnread() ? `<span class="dot">${totalUnread() > 9 ? '9+' : totalUnread()}</span>` : ''
      }</button>
      <button class="iconbtn only-desktop" data-act="theme" aria-label="Toggle theme">${S.theme === 'dark' ? '☀' : '☾'}</button>
      <span class="avatar" title="${esc(S.me.name || '')} · ${esc(S.profile ? S.profile.role : '')}">${esc(initials || '?')}</span>
    </div>
  </header>`;
}

export function tabbarHtml() {
  const kind = currentKind();
  const tabs = navFor(kind).flatMap((s) => s.items);
  const quick = [
    ['dashboard', 'Home', '◧'],
    ['expenses', kind === 'office' ? 'Spend' : 'Spending', '₹'],
    ['add', 'Add', '+'],
    ['notifications', 'Alerts', '🔔'],
    ['more', 'More', '⋯'],
  ];
  return `<nav class="tabbar" aria-label="Quick navigation">
    ${quick
      .map(([id, label, glyph]) => {
        if (id === 'add') {
          return `<button class="tabitem fab" data-act="add" data-ek="${esc(defaultCollection())}" aria-label="Add a record"><span aria-hidden="true">+</span><small>Add</small></button>`;
        }
        if (id === 'more') {
          return `<button class="tabitem${S.drawer ? ' on' : ''}" data-act="drawer" aria-label="More sections"><span aria-hidden="true">⋯</span><small>More</small>${
            totalUnread() ? '<i class="tagdot"></i>' : ''
          }</button>`;
        }
        const exists = tabs.some((t) => t[0] === id);
        const on = S.tab === id;
        return `<button class="tabitem${on ? ' on' : ''}" data-tab="${exists ? id : 'dashboard'}" aria-current="${on ? 'page' : 'false'}"><span aria-hidden="true">${glyph}</span><small>${label}</small>${
          id === 'notifications' && totalUnread() ? '<i class="tagdot"></i>' : ''
        }</button>`;
      })
      .join('')}
  </nav>`;
}

function defaultCollection() {
  // Every profile kind starts a quick-add in its ledger; the form itself is the
  // same, so there is nothing kind-specific to branch on.
  return 'expenses';
}

export function titleFor(tab) {
  const found = navFor().flatMap((s) => s.items).find(([id]) => id === tab);
  if (found) return found[1];
  const map = {
    budgetIn: 'Income budget',
    budgetEx: 'Expense budget',
    reports: 'Reports',
    notifications: 'Notifications',
  };
  return map[tab] || 'Family Finance Planner';
}
