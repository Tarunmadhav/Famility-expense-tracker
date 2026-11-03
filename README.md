# Family Finance Planner

A household finance planner that runs as a **website** and as an **installable Android app** from one
codebase: one D1 database, one Worker API, one realtime connection, system notifications on mobile.

It carries over every analytics screen from the original single-file offline planner (dashboard KPIs,
seven charts, watch tables, budget views, contact search, calendar alerts, CSV import/export) and adds
a real database, live multi-device sync, PIN-protected sessions and push notifications.

---

## Live

* **Website / Android app:** https://site-0f6d51dc534d4dd4af419f3a4cf5f0ad.freebuff.page
* **Preview:** https://site-d5cebd755082457297c63980e1b24526.freebuff.page
* **Family PIN:** `135790` — change it in Settings → Security after the first sign-in.

## What is in the box

| Area | Implementation |
| --- | --- |
| Web app | Vanilla ES modules + Vite (`web/`), 54 kB gzipped, no runtime frameworks |
| API | Single module Worker (`src/worker.js`), no dependencies |
| Database | Cloudflare D1 (`records`, `users`, `sessions`, `changes`, `notifications`, `push_subs`) |
| Live sync | Server-Sent Events with revision diffs (`/api/events`) + 30 s safety poll |
| Notifications | Server-side event sweep + Web Push (VAPID/aes128gcm, WebCrypto) + in-app bell |
| Android | Installable PWA (manifest + service worker) with `AndroidBridge` hook for a native shell |
| Accounts | Family PIN for the owner, plus email + password signup for other members (PBKDF2-SHA256, hashed sessions) |
| Subscriptions | Recurring-service tracker with normalised monthly/yearly cost and renewal alerts |
| Documents drive | R2 bucket for bill/receipt/policy uploads (8 MB, images + PDF), attached to records |
| Bill scanning | Upload a receipt, the configured vision model fills in date, merchant, amount, category |
| AI tools | Connect any OpenAI-compatible provider; keys stay server-side and are never returned |
| Security | PIN/password auth, hashed session tokens, HttpOnly cookies, CSP, origin checks, rate limiting |

## Analytics (all preserved from the reference app)

* 10 KPI cards: income, expenses, surplus, debt, EMIs, daily spend, unpaid bills, insurance cover, open tasks, contacts
* Financial-health strip: savings rate, EMI/income, budget utilised, cover vs one year of spending
* Charts: income vs expenses (planned/actual), expenses by category, daily spend donut, loans
  outstanding vs EMI, insurance coverage, paid vs unpaid bills, diary status
* Tables: bills & dues, insurance renewals, uncompleted tasks, upcoming birthdays
* Module views: Family, Contacts, Daily Expenses, Bills, Loans, Insurance, Diary & Tasks, Monthly
  Budget (income + expenses) — each with search, filters, sort, pagination, computed columns, totals,
  add/edit/delete, "mark paid/completed", CSV export, CSV template, CSV import, Google Calendar link
* Family members: card view to add each member (relation, role, mobile, email, birthday,
  occupation, ICE flag, notes) with call/WhatsApp shortcuts, plus a family strip on the dashboard
* Interactivity: KPI and health cards open the matching module, alert lines jump to the record's
  module, charts carry hover tooltips, search filters as you type
* Sharing: WhatsApp and SMS buttons prefill the alert text (dashboard digest, each notification,
  each bill/policy/task row, each family member) — nothing is sent automatically
* Utilities: contact search by name→number and number→name, India-format money/date helpers,
  `.ics` calendar export with per-event alarms, Google Contacts CSV import, JSON backup

### CSV round-trip

Every module toolbar has **Export**, **Template** and **Import CSV**. The template is a header-only
file (`Date,Expense / merchant,Amount,...`); fill it in a spreadsheet and import it back. Amounts may
contain `₹`/thousands separators, dates may be `YYYY-MM-DD` or `DD/MM/YYYY`, and column order is
free as long as the headers match. A Google Contacts export is detected automatically in Contacts.

## Data model

`records(collection, id, doc JSON, rev, updated_at, updated_by)` holds the ten collections
(`family`, `contacts`, `subscriptions`, `expenses`, `payments`, `loans`, `insurance`, `diary`,
`budgetIn`, `budgetEx`). Supporting tables: `users`, `credentials` (email + password hash),
`sessions`, `changes`, `notifications`, `push_subs`, `files` (drive index), `ai_connections`.
Every write appends to `changes(seq, collection, record_id, op, actor, ts)`; `seq` is the global
revision used by the live-sync diffs and by the activity feed. Field definitions, allowed values and
limits live in `web/src/entities.js`, which both the UI and the server sanitiser import, so the API
only ever stores known fields with coerced types.

## Realtime

1. A write inserts a `changes` row and bumps the revision.
2. `GET /api/events?since=<rev>` stays open (pings every 2.5 s) and emits `event: change` when the
   revision moves, then closes.
3. The client pulls `/api/state?since=<rev>`, receives only the changed documents plus delete
   tombstones, merges them into memory and re-renders.

No Durable Objects or websocket fan-out are needed, so it runs on the managed Workers platform.

## Notifications


`src/store.js` → `sweep()` runs at most once a minute (on any authenticated request) and creates
deduplicated notifications for:

* bills due in ≤ 3 days (and overdue)
* insurance renewals at 30 / 7 / 1 days
* uncompleted tasks due in ≤ 3 days
* birthdays in ≤ 7 days
* budget categories that go over plan on save

Fresh notifications are pushed to every subscribed device through `src/push.js` (VAPID JWT + RFC 8291
`aes128gcm` payload encryption, all WebCrypto). Devices that are open show a bell badge, a toast and
a system notification through the service worker; the Android shell can show them natively via
`window.AndroidBridge.notify(title, body)`.

## Accounts, subscriptions, drive and AI

**Accounts.** The household owner unlocks with the family PIN. Everyone else can create a member
account from the sign-in screen with an email and password (`POST /api/auth/signup`); members share
the same household data. Passwords are stored as PBKDF2-SHA256 with a unique salt, and changing a
password signs out every other device. Sign-in is capped at 8 failures per IP per 15 minutes.

**Subscriptions.** A dedicated tab tracks service, plan, amount, billing cycle, next renewal and
account. It normalises mixed cycles into a monthly and yearly cost, lists what renews next, and feeds
the notification sweep three days before a renewal.

**Documents drive.** Uploaded bills and policy documents go to the R2 bucket bound as `FILES`
(`/api/files`), are indexed in `files`, and are attached to an expense or insurance record through a
`file`-type field. The file type is decided by sniffing the bytes (JPEG/PNG/WebP/PDF), size is capped
at 8 MB, and every download requires a session. The Settings page lists everything stored with total
size used, and each attachment is a 📎 link in its table row.

**Bill scanning.** In the Expenses form, choose a photo and press **📷 Scan bill**. The Worker sends
the image to the connected vision model with a JSON-only prompt and prefills date, merchant, amount,
category, payment method and line items; you review and save. Nothing is saved until you confirm.

**AI tools.** Settings → AI tools accepts any OpenAI-compatible endpoint (provider label, base URL,
model, API key). The key is stored in D1, never returned by the API, and only used for a scan you
started. Plain HTTP and private/loopback hosts are rejected. A **Test** button sends a one-token
prompt to verify the connection.

## Books, membership and locking

**Three books per account.** `family` is the shared household book; `personal` and `office` are
private to the signed-in user. The server maps the `X-Space` header to `family`, `u:<userId>` or
`o:<userId>` and every query filters on that column — a book cannot read, edit or delete another
book's rows or files, even with a hand-crafted request. The Office book deliberately exposes only
tasks/notes, contacts, expenses and files.

**Membership.** The first account is the household owner. New accounts need a one-time invite code
(Settings → Family members, 72 hours, single use); the owner can remove a member, which deletes their
personal and office books, credentials and sessions. Members cannot invite or remove anyone.

**Auto-lock.** Inactivity locks the screen after 30 s / 1 min / 5 min / 15 min or a custom timeout.
Locking calls `POST /api/auth/lock`, which deletes the session row and clears the cookie, so a copied
cookie or another tab stops working immediately; the lock screen then wipes the loaded records and the
rendered DOM, and unlocking issues a fresh session. Ten-second checks plus a `visibilitychange` handler
cover tab switches and device sleep.

**Field encryption.** Phone numbers, emails and free-text notes for contacts, family, bills, policies,
loans, subscriptions and diary entries are sealed with AES-256-GCM before they reach D1, using the
`FIELD_KEY` Worker secret (32 random bytes, base64). Values written before the key existed stay
readable, and if the key is missing the app keeps working in plaintext rather than corrupting data.

## Performance

* `GET /api/state` now runs two batched D1 round-trips (metadata + notifications, then the record
diff) instead of six sequential queries, and live updates reuse the same diff path.
* Fingerprinted assets under `/assets/*` are served `Cache-Control: public, max-age=31536000, immutable`,
  so repeat visits no longer revalidate the bundle (measured: warm API calls 29–52 ms locally, median
  ≈ 41 ms; the dev server dominates that number, so treat it as a smoke-level measurement, not a
  production benchmark).
* The SPA ships as one 73 kB JS + 9 kB CSS bundle (24 kB + 3 kB gzipped) with no framework runtime.

## Security

* PIN is stored as PBKDF2-SHA256 (120 000 iterations, per-user salt, constant-time compare)
* Session token is 32 random bytes; only its SHA-256 hash is stored, the cookie is `HttpOnly`,
  `SameSite=Lax`, `Secure` on HTTPS, and expires after 30 days
* 8 failed logins per IP in 15 minutes locks logins for that IP
* Every non-GET request is rejected unless `Origin`/`Sec-Fetch-Site` says same-origin
* All SQL uses bound parameters; record ids are validated by pattern; collection names are allow-listed
* Only declared fields are stored, with type coercion and length caps (unknown keys are dropped)
* CSP (`script-src 'self'`, `frame-ancestors 'none'`), nosniff, DENY framing, no-referrer,
  permissions policy, no-store on API responses
* Password reset is deliberately "reset the database" — there is no email dependency to attack
* Personal address books are **not** bundled in the source; import your own CSV

## Local development

```bash
npm install
npm run build          # icons + SPA (dist/) + build/worker.js + deploy.json
npm run dev:api        # Worker + D1 on http://127.0.0.1:8787  (serves dist/)
npm run dev            # optional Vite hot-reload UI on http://127.0.0.1:5173 (proxies /api)
npm run smoke          # end-to-end API/security checks against a running Worker
```

The first visit asks you to create the family PIN and loads the starter dataset
(the household budget, bills, loans, policies, diary and 16 contacts from the reference app).

## Deploy (Cloudflare Workers + D1 via Sites)

`npm run build` produces:

* `dist/` — SPA, manifest, service worker, icons (served directly by `wrangler dev`)
* `build/worker.js` — bundled Worker
* `build/static/` — uploadable assets (JS/text/JSON only; icons come from the Worker)
* `deploy.json` — deploy manifest at the workspace root

Create the site, provision a D1 database bound as `DB`, then deploy with that manifest.

## Android

Two ways to run it on a phone, both from the same codebase:

**1. Install the PWA** — open the live URL in Chrome on Android → menu → **Install app** (or the
**Install app** button in Settings). Standalone icon, offline shell, and Web Push notifications
(Chrome delivers them through FCM even when the app is closed).

**2. Install the native APK** — `android/FamilyPlanner.apk` is built and signed locally:

```bash
bash android/build.sh     # aapt2 + javac + d8 + apksigner, no Gradle, no network
```

It is a WebView shell around the live planner: cookies persist the PIN session, the back button
walks history, external links open in the browser, and the web app calls
`window.AndroidBridge.notify(title, body)` so every planner alert becomes a real Android
notification (the shell requests `POST_NOTIFICATIONS` on first launch).

The shell URL lives in `MainActivity.START_URL` — change it if you point the app at a custom domain.
Note that a WebView shell cannot receive push while it is closed; use the installed PWA when you
want background alerts too.
