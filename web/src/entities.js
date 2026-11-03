// Single source of truth for the data model.
// Imported by the browser app (UI + forms + tables) and by the Worker (input sanitising).
// Pure data/helpers only - no DOM access, so the Worker can bundle it.

export const PAY = ['Paid', 'Unpaid'];

function F(k, l, t = 'text', o = null, max = 0) {
  return { k, l, t, o, max };
}

export const COLLECTIONS = {
  contacts: {
    label: 'Contacts Directory',
    dark: '#0F766E',
    tint: '#DDF2EE',
    page: 40,
    autoId: 'CNT',
    fields: [
      F('id', 'ID'),
      F('name', 'Name', 'text', null, 120),
      F('rel', 'Relationship', 'text', null, 60),
      F('mobile', 'Mobile', 'tel'),
      F('alt', 'Alternative', 'tel'),
      F('email', 'Email', 'text', null, 120),
      F('bday', 'Birthday', 'date'),
      F('org', 'Organisation', 'text', null, 160),
      F('module', 'Linked module'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  family: {
    label: 'Family Members',
    dark: '#0E7490',
    tint: '#D6EFF4',
    page: 24,
    fields: [
      F('name', 'Name', 'text', null, 80),
      F('relation', 'Relation', 'text', null, 40),
      F('role', 'Role', 'select', ['Adult', 'Child', 'Senior', 'Dependent']),
      F('mobile', 'Mobile', 'tel'),
      F('alt', 'Alternate', 'tel'),
      F('email', 'Email', 'text', null, 120),
      F('bday', 'Birthday', 'date'),
      F('occupation', 'Occupation', 'text', null, 80),
      F('ice', 'Emergency contact', 'select', ['No', 'Yes']),
      F('notes', 'Notes', 'area', null, 300),
    ],
  },
  expenses: {
    label: 'Daily Expenses',
    dark: '#C2410C',
    tint: '#FDE9DC',
    page: 25,
    fields: [
      F('date', 'Date', 'date'),
      F('item', 'Expense / merchant', 'text', null, 140),
      F('cat', 'Category', 'text', null, 60),
      F('method', 'Payment method', 'text', null, 60),
      F('amount', 'Amount', 'money'),
      F('status', 'Status', 'select', PAY),
      F('merchant', 'Payee', 'text', null, 120),
      F('phone', 'Phone', 'tel'),
      F('ref', 'Receipt / ref', 'text', null, 64),
      F('attachment', 'Receipt file', 'file'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  subscriptions: {
    label: 'Subscriptions',
    dark: '#7C3AED',
    tint: '#EDE9FE',
    page: 25,
    fields: [
      F('service', 'Service', 'text', null, 80),
      F('plan', 'Plan', 'text', null, 60),
      F('category', 'Category', 'text', null, 40),
      F('amount', 'Amount', 'money'),
      F('cycle', 'Billing cycle', 'select', ['Monthly', 'Quarterly', 'Yearly', 'One-time']),
      F('nextDue', 'Next renewal', 'date'),
      F('method', 'Paid with', 'text', null, 60),
      F('account', 'Account / email', 'text', null, 100),
      F('status', 'Status', 'select', ['Active', 'Paused', 'Cancelled']),
      F('url', 'Website', 'text', null, 120),
      F('notes', 'Notes', 'area', null, 300),
    ],
  },
  payments: {
    label: 'Payment History & Bills',
    dark: '#6D28D9',
    tint: '#EBE3FB',
    page: 25,
    fields: [
      F('txn', 'Txn date'),
      F('due', 'Due date', 'date'),
      F('payee', 'Payee / bill', 'text', null, 140),
      F('cat', 'Category', 'text', null, 60),
      F('amount', 'Amount', 'money'),
      F('mode', 'Payment mode', 'text', null, 60),
      F('status', 'Status', 'select', PAY),
      F('contact', 'Contact', 'text', null, 120),
      F('phone', 'Phone', 'tel'),
      F('ref', 'Reference', 'text', null, 64),
      F('alert', 'Alert to mobile', 'tel'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  loans: {
    label: 'Loans & Credit',
    dark: '#B91C1C',
    tint: '#FADEDE',
    page: 25,
    fields: [
      F('name', 'Facility', 'text', null, 120),
      F('type', 'Type', 'text', null, 60),
      F('lender', 'Lender', 'text', null, 120),
      F('officer', 'Officer', 'text', null, 120),
      F('phone', 'Officer phone', 'tel'),
      F('rate', 'Interest', 'pct'),
      F('principal', 'Sanctioned', 'money'),
      F('emi', 'Monthly EMI', 'money'),
      F('outstanding', 'Outstanding', 'money'),
      F('closure', 'Target closure', 'text', null, 40),
      F('status', 'Status', 'select', ['Active', 'Closed']),
      F('autodebit', 'Auto-debit bank', 'text', null, 80),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  insurance: {
    label: 'Insurance Register',
    dark: '#1D4ED8',
    tint: '#DEE8FC',
    page: 25,
    fields: [
      F('name', 'Policy', 'text', null, 140),
      F('cat', 'Category', 'text', null, 60),
      F('insurer', 'Insurer', 'text', null, 120),
      F('policyno', 'Policy no.', 'text', null, 64),
      F('insured', 'Insured', 'text', null, 140),
      F('sum', 'Coverage', 'money'),
      F('premium', 'Premium', 'money'),
      F('renewal', 'Renewal date', 'date'),
      F('freq', 'Frequency', 'text', null, 40),
      F('nominee', 'Nominee', 'text', null, 120),
      F('advisor', 'Advisor', 'text', null, 120),
      F('phone', 'Advisor phone', 'tel'),
      F('alert', 'Alert', 'text', null, 80),
      F('attachment', 'Policy document', 'file'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  diary: {
    label: 'Daily Diary & Tasks',
    dark: '#BE185D',
    tint: '#FBDDEB',
    page: 25,
    fields: [
      F('date', 'Date', 'date'),
      F('cat', 'Category', 'text', null, 60),
      F('title', 'Title', 'text', null, 160),
      F('notes', 'Notes', 'area'),
      F('contact', 'Contact', 'text', null, 120),
      F('phone', 'Phone', 'tel'),
      F('follow', 'Follow-up action', 'text', null, 200),
      F('priority', 'Priority', 'select', ['High', 'Medium', 'Low']),
      F('status', 'Status', 'select', ['Pending', 'Incomplete', 'Completed']),
      F('due', 'Due date (calendar)', 'date'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  budgetIn: {
    label: 'Monthly Budget - Income',
    dark: '#15803D',
    tint: '#DFF3E5',
    page: 50,
    fields: [
      F('source', 'Income source', 'text', null, 140),
      F('planned', 'Planned', 'money'),
      F('actual', 'Actual', 'money'),
      F('payer', 'Payer / contact', 'text', null, 120),
      F('phone', 'Phone', 'tel'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
  budgetEx: {
    label: 'Monthly Budget - Expenses',
    dark: '#B91C1C',
    tint: '#FADEDE',
    page: 50,
    fields: [
      F('source', 'Expense category', 'text', null, 140),
      F('planned', 'Planned', 'money'),
      F('actual', 'Actual', 'money'),
      F('payer', 'Contact', 'text', null, 120),
      F('phone', 'Phone', 'tel'),
      F('remarks', 'Remarks', 'area', null, 400),
    ],
  },
};

export const COLLECTION_NAMES = Object.keys(COLLECTIONS);

/** Coerce one field value to its declared type, dropping anything unexpected. */
export function coerce(field, raw) {
  if (raw === null || raw === undefined) return field.t === 'money' || field.t === 'pct' ? 0 : '';
  switch (field.t) {
    case 'money':
    case 'pct': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
    }
    case 'date': {
      const s = String(raw).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      if (/^--\d{2}-\d{2}$/.test(s)) return s;
      return '';
    }
    case 'select':
      return field.o.includes(String(raw)) ? String(raw) : field.o[0];
    case 'file': {
      const value = String(raw).trim();
      return /^[0-9a-f-]{36}$/i.test(value) ? value : '';
    }
    default: {
      const limit = field.max || 500;
      return String(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit);
    }
  }
}

/** Build a clean document for `collection` from untrusted input. Unknown keys are dropped. */
export function sanitizeDoc(collection, input) {
  const def = COLLECTIONS[collection];
  if (!def) return null;
  const src = input && typeof input === 'object' ? input : {};
  const doc = {};
  for (const field of def.fields) {
    if (field.k === 'id' && def.autoId) continue;
    doc[field.k] = coerce(field, src[field.k]);
  }
  if (def.autoId) doc.id = '';
  return doc;
}
