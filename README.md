# Family Finance Planner

A household finance planner that runs as a **website** and as an **installable Android app** from one
codebase: one D1 database, one Worker API, one realtime connection, system notifications on mobile.

It carries over every analytics screen from the original single-file offline planner (dashboard KPIs,
seven charts, watch tables, budget views, contact search, calendar alerts, CSV import/export) and adds
a real database, live multi-device sync, PIN-protected sessions and push notifications.

---

## Live

* **Website / Android app:** https://family-finance-planner.tarungudipatimadhav.workers.dev
* **Hosting:** your own Cloudflare account (Workers free plan) — Worker `family-finance-planner`,
  D1 `family-planner` (APAC, region `SIN`), R2 bucket `family-planner-drive` bound as `FILES`.
  API version **9**, app version **2.1.0** (`GET /api/version`).
* **Family PIN:** none yet. This deployment starts from an empty database, so the first visit asks
  you to create the household and choose the PIN.
* The previous deployment at `site-0f6d51dc…freebuff.page` is untouched and still holds the old data.

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
| Profiles | Family, Office and Personal profiles per account, switched without signing out |
| Roles | Owner / Admin / Editor / Viewer, enforced on the server for every route |
| Audit trail | Sign-ins, failed sign-ins, profile switches, sharing, role changes, exports, deletions |
| Backups | AES-256-GCM encrypted backups made in the browser, with validated restore |

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
  occupation, ICE flag, notes) with call shortcuts, plus a family strip on the dashboard
* Interactivity: KPI and health cards open the matching module, alert lines jump to the record's
  module, charts carry hover tooltips, search filters as you type
* Alerts: raised by the server for bills, renewals, tasks and birthdays, shown in the app, pushed to
  devices, and optionally delivered to a Telegram chat you link yourself
* Utilities: contact search by name→number and number→name, India-format money/date helpers,
  `.ics` calendar export with per-event alarms, Google Contacts CSV import, JSON backup

### Spreadsheet round-trip

Every module toolbar has **Export**, **Template** and **Import**. The template is a header-only
file (`Date,Expense / merchant,Amount,...`); fill it in a spreadsheet and import it back as `.csv`
(including the UTF-8 BOM Excel writes) or `.xlsx`/`.xlsm`, first worksheet. Amounts may contain
`₹` and thousands separators (`1,23,456.00`, `12,345/-`), dates may be `YYYY-MM-DD`, `DD/MM/YYYY`,
`DD-MM-YY`, `DD Mon YYYY`, or a real Excel date cell, and column order is free as long as the
headers match. A Google Contacts export is detected automatically in Contacts.

A file is checked before anything is saved: any bad cell is reported with its line number, the
column and the reason, and the whole file is refused rather than half-imported. Limits are 2 MB and
500 data rows per file. Importing the same file twice adds nothing the second time — rows are
compared by content (contacts also by mobile number) — and the rows of one file are written in a
single D1 transaction.

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

**Three profiles per account.** Every account owns a private `personal` and `office` profile and
belongs to the `family` profile of its household. A profile id **is** the storage namespace
(`family` or `h:<owner>`, `u:<userId>`, `o:<userId>`), so every existing query stays scoped exactly as
before. The client names the profile it wants (`X-Profile`, or `?profile=` for the event stream) and
the Worker proves membership in `profile_members` on every single request: a forged, guessed or
foreign profile id answers **404**, never data. The Office profile deliberately exposes only tasks,
contacts, expenses, budgets and files.

**Roles.** `owner` (everything, including invites), `admin` (records, settings and members),
`editor` (view, add, edit, delete, export) and `viewer` (view and export only). The mapping lives in
one function, `permissionFor()` in `src/worker.js`, so a new route cannot ship without an
access check. Accounts that were plain household "members" before roles existed become `editors`,
keeping their previous abilities without gaining member management.

**Membership.** The first account owns the household. New accounts need a one-time invite code
(Settings → People with access, 72 hours, single use). Removing a member deletes their private
profiles, documents (rows and R2 objects), credentials and sessions, and touches nothing in the
shared family profile.

**Auto-lock.** Inactivity locks the screen after 30 s / 1 min / 5 min / 15 min or a custom timeout.
Locking calls `POST /api/auth/lock`, which deletes the session row and clears the cookie, so a copied
cookie or another tab stops working immediately; the lock screen then wipes the loaded records and the
rendered DOM, and unlocking issues a fresh session. Ten-second checks plus a `visibilitychange` handler
cover tab switches and device sleep.

**Field encryption.** Phone numbers, emails and free-text notes for contacts, family, bills, policies,
loans, subscriptions and diary entries are sealed with AES-256-GCM before they reach D1, using the
`FIELD_KEY` Worker secret (32 random bytes, base64). Values written before the key existed stay
readable, and if the key is missing the app keeps working in plaintext rather than corrupting data.

## Backups, versions and updates

**Encrypted backups.** Settings → Backup & restore exports only the profile you are in. The browser
seals it with AES-256-GCM under a key derived from a passphrase you type (PBKDF2-SHA-256, 210 000
iterations, random salt per backup). The passphrase and key never leave the device, so the file is
readable only by someone who knows the passphrase — safe to park in Google Drive or a USB
stick. Restore decrypts locally, proves the file is authentic (a tampered or wrong-passphrase file
fails the GCM check), shows the date and record count, asks for confirmation, then merges by id
without wiping the profile first.

**Versions.** `GET /api/version` returns the app version, API version and an optional `release`
object (`version`, `minimum`, `notes`, `apkUrl`, `apkSha256`) stored in D1 `meta`. When `minimum` is
higher than the running client, the web app shows an update banner. Nothing is served from that
object that the app trusts for security; it only drives the notice.

**Frontend updates need no reinstall.** The Worker serves the newest build and the service worker
fetches navigations network-first with a versioned cache name (`ffp-shell-v2`), so a phone picks up a
new bundle on the next launch while hashed assets stay immutably cached. Only changes to the native
Android shell itself need a new APK install.

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

## Security audit (what is enforced where)

Every item below is enforced by the Worker, not by the browser. `scripts/security-test.mjs` proves the
interesting half of it on a throwaway database, and the suite is the thing to rerun after any change
(46 checks, including forged profile ids, cross-account file reads and privilege-escalation attempts).

| Requirement | How it is met |
| --- | --- |
| No secrets in frontend code | The SPA bundle contains no keys. `FIELD_KEY`, VAPID private key and stored AI keys live only in the Worker env / D1 and are never serialised to a client (`apiKey` is stripped on read). `grep` of `dist/` finds no key material. |
| `.env` never public | `.env`, `.env.*`, `.dev.vars`, `.secrets/`, `*.jks`, `*.keystore`, `keystore.properties`, `migration/out/` and `*.apk` (except the published build) are git-ignored; only `web/public/**` is shipped, and it contains no env file. |
| Server-side authentication | Sessions are `HttpOnly` cookies holding 32 random bytes; only their SHA-256 hash is stored. Every route outside `/api/health`, `/api/version`, `/api/auth/*` and `/api/push/*` requires a live session row, checked before the handler runs. |
| IDOR | Record ids, file ids, profile ids and member ids from the client are re-resolved server-side. A profile id must exist in `profile_members` for the caller (otherwise **404**, not 403, so ids cannot be probed); a file id must belong to the caller's profile; member rows must belong to the profile being managed. |
| Row-level security | D1 has no RLS, so the equivalent is structural: every query in `src/store.js` is bound to a `space` argument, `resolveProfile()` is the single gate that decides it, and the tables have no cross-profile foreign reads. This is asserted by tests that read another household's ids directly. |
| Admin endpoints | There are no hidden admin pages; `/api/admin/*` (reset, clear, sample) requires the `manage` permission on the resolved profile, which only owner/admin hold. The migration snapshot additionally requires the `owner` role **and** the `MIGRATION_MODE=1` env flag, otherwise it is a 404. |
| HTTPS | Plain-HTTP requests are answered with a `308` to the HTTPS URL (loopback exempted for local dev), the session cookie is `Secure` on any non-localhost host, and `Strict-Transport-Security: max-age=31536000; includeSubDomains` is set on every response. |
| Input validation | Bodies must be `application/json` (≤ 4 MB) or a multipart upload (≤ 8 MB, magic-byte sniffed to JPEG/PNG/WebP/PDF); collections are allow-listed; ids are pattern-checked; every stored field is coerced through `sanitizeDoc()` with length caps and unknown keys dropped. |
| Password hashing | PBKDF2-SHA-256, per-user random salt, 100 000 iterations, constant-time compare. The iteration count is stored per credential row, so a future increase can be applied on next login. 100 000 is the ceiling that keeps a login inside the free plan's per-request CPU budget on real hardware; the extra hardening is the 8-attempts-per-15-minutes lockout per IP. |
| SQL injection | All SQL uses bound parameters. The only interpolated identifiers are internal table/column names from hard-coded lists, never request data. |
| XSS | The CSP forbids inline and remote scripts (`script-src 'self'`), and every value rendered into HTML passes through `esc()`; the audit found and fixed one unescaped chart label. Toasts and file names use `textContent`. |
| CSRF | Every non-GET request must be same-origin: `Origin` must match the request host, or `Sec-Fetch-Site` must be `same-origin`/`none`. A cross-site POST is rejected with 403 before any handler. |
| Least privilege | Four roles with an explicit permission table; `permissionFor()` maps each route to a permission and is the only place that decides, so an unmapped route still has a default. Viewers cannot write, upload, change settings, invite, read audit or change the household PIN. |
| No internal errors leaked | Unexpected failures return `{"error":"Unexpected server error"}` with no SQL text, stack or binding names; diagnostics go to the Worker log (`console.error`). |
| Rate limiting | Login/signup: 8 failures per IP per 15 minutes (plus `auth_fails` audit rows). Authenticated writes: 120 per user per minute. Exports: 30 per user per hour. Setup: 5 attempts per IP per hour. |
| Frontend checks are not trusted | The UI hides controls as a courtesy; the server recomputes every permission. Tests call the API directly to confirm the denials hold. |

## Accounts: several people, one deployment

Every account owns its **own** book. The account created by the first-run setup keeps the original
`family` book; each later account (signup or a second PIN) is placed in its own `h:<id>` book, and the
old rows it had written are moved with it once, on the first boot after the upgrade. Sharing is opt-in:
send an invite from Settings and that account joins your household book as editor, viewer, admin or
co-owner.

### Sign-in options

The sign-in card has one method switch (email + password, or the family PIN) and one link each for
"forgot" and "create an account". Signing up is allowed on a completely empty deployment, so the
first person does not have to use the PIN setup screen first; that screen is still offered as a link
for households that prefer one shared PIN.

### Forgotten PIN or password

There is no email sender in this deployment, so each account gets a **recovery code** at setup/signup
(and again from Settings). It is shown once, stored only as a PBKDF2 hash, and is single-use:
`/api/auth/recover` swaps it for a new PIN and returns a fresh code. The sign-in screen has a
"Forgot password?" link for both paths (recovery code, or reset a password with the family PIN).

### Two-factor authentication

`Settings → Two-factor & recovery` enrols TOTP (RFC 6238, six digits, 30 s step) with any authenticator
app; the provisioning URI and key are shown once. The Worker checks the code at login, tolerates one
step of clock drift, and stores the accepted time step so a code cannot be replayed. Enabling it also
issues a recovery code, because a lost phone must not mean a lost account. Deleting the secret requires
a current code. Implementation: `src/twofactor.js`, `verifyTotp()` in `src/store.js`.

### Google Drive backups

Google Drive is the only cloud provider. The client id is public and lives in `wrangler.jsonc` vars; the
secret is a Worker secret:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Register `<your-worker-url>/api/cloud/callback/google` as the redirect URI, and enable the Drive API
with the `drive.appdata` scope (an app-private folder the user cannot browse). Until both values exist
the API answers `501` naming the missing variable and Settings shows "Google setup incomplete (owner
action needed: NAME)", so nothing silently fails. Tokens are sealed with `BACKUP_KEY` before they reach
D1 in `cloud_links` and are never sent to the browser; without it the card says "Backup key not set
(owner action needed: BACKUP_KEY)". Connecting is one tap in Settings ("Connect Google Drive"): the
button goes straight to Google, the callback returns to the app, and the card then reads "Drive
connected".

### Email codes (password reset)

`Forgot password` sends a six-digit code (ten minutes, five attempts, single use) through
[Resend](https://resend.com):

```bash
npx wrangler secret put RESEND_API_KEY
```

The sender is `MAIL_FROM` in `wrangler.jsonc` (a public var, not a secret). It ships as
`onboarding@resend.dev`, Resend's own test address, which **only delivers to the Resend account owner**;
replace it with an address on a verified domain before anybody else signs in by email code.

Without `RESEND_API_KEY` the endpoint answers `501` naming the variable and the form stays visible, so
the failure is explicit. Verification is server-side (`createEmailOtp` / `consumeEmailOtp` in
`src/store.js`): the code is stored only as a PBKDF2 hash, expires, is limited to five attempts, and a
new request replaces the previous code. The request endpoint always answers `ok`, so it cannot be used
to discover which addresses have accounts.

### Social sign-in (Google)

Google is the only sign-in provider with credentials wired: `GOOGLE_CLIENT_ID` in `wrangler.jsonc` vars
(shared with the Drive connector) and `GOOGLE_CLIENT_SECRET` as a Worker secret. Facebook and GitHub
remain in `src/oauth.js` as optional providers but have no credentials, so no button appears for them.

Redirect URI: `<worker-url>/api/auth/oauth/callback/google`. An existing email keeps its account and its
data; a new email creates an account in its own book. The OAuth state value is single-use and expires
after ten minutes.

### Telegram alerts

One bot serves every household in the deployment. A chat receives nothing until it is linked from a
signed-in session, and every send resolves its recipients from D1 at that moment. The bot is
`@FamilyFinancePlanner_bot`; its public username lives in `wrangler.jsonc` as `TELEGRAM_BOT_USERNAME`, and
Settings → Notifications → Telegram offers a **Start chatting** button that opens
`https://t.me/FamilyFinancePlanner_bot` in the browser or the Telegram app.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN      # from @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # any random string
```

Then point the bot at the deployment, passing the same secret:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<worker-url>/api/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Full setup, command list and the security model: [docs/TELEGRAM.md](docs/TELEGRAM.md). In short:
`/start`, `/link CODE`, `/status`, `/settings`, `/unlink`, `/help`; a link code is single use, expires in
ten minutes and is stored only as a hash; one Telegram identity per planner account and one account per
identity; the webhook rejects any request whose `X-Telegram-Bot-Api-Secret-Token` does not match; the
default alert is a generic "You have a new planner alert" and amounts are opt-in per chat.

## Owner secret checklist

Deploy the Worker first (`npx wrangler deploy`), then set only the secrets that are missing. Names are
listed, never values; `npx wrangler secret list` prints the same list without them.

| Name | Kind | Needed for | Set with |
| --- | --- | --- | --- |
| `FIELD_KEY` | secret | encrypting phones, emails, notes | `npx wrangler secret put FIELD_KEY` |
| `BACKUP_KEY` | secret | sealing Google Drive refresh tokens | `npx wrangler secret put BACKUP_KEY` |
| `GOOGLE_CLIENT_SECRET` | secret | Google sign-in and Drive | `npx wrangler secret put GOOGLE_CLIENT_SECRET` |
| `RESEND_API_KEY` | secret | email codes for password reset | `npx wrangler secret put RESEND_API_KEY` |
| `TELEGRAM_BOT_TOKEN` | secret | Telegram alerts | `npx wrangler secret put TELEGRAM_BOT_TOKEN` |
| `TELEGRAM_WEBHOOK_SECRET` | secret | accepting Telegram updates | `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`, then re-run `setWebhook` with the same value |

Public configuration lives in `wrangler.jsonc` and must never move into a secret or the other way round:
`ANDROID_SHA256`, `GOOGLE_CLIENT_ID`, `MAIL_FROM`, `TELEGRAM_BOT_USERNAME`. A name defined in both places
is a bug — the var wins in `env` and the secret silently never applies.

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

## Deploy (your own Cloudflare account)

`npm run build` produces:

* `dist/` — SPA, manifest, service worker, icons (uploaded as Worker static assets)
* `build/worker.js` — bundled Worker
* `build/static/` — text-only asset copy
* `deploy.json` — manifest for the managed Sites uploader (not used by `wrangler`)

`wrangler.jsonc` is the deployment config for a plain Cloudflare account. First-time setup:

```bash
npx wrangler login
npx wrangler d1 create family-planner          # copy the database_id into wrangler.jsonc
npm run build
npx wrangler deploy
npx wrangler secret put FIELD_KEY < .secrets/field_key.txt   # 32 random bytes, base64
```

The Worker creates its own schema on the first request — there are no migrations to apply.

**Documents drive.** R2 is enabled on this account and the bucket `family-planner-drive` is bound as
`FILES` in `wrangler.jsonc`. Uploads are limited to 8 MB, sniffed for JPEG/PNG/WebP/PDF content
(never trusted from the header), stored under `drive/<uuid>.<ext>`, and every read or delete is
scoped to the caller's profile: a known file id from another profile answers 404. On a fresh
account, run `npx wrangler r2 bucket create family-planner-drive` first and keep the binding.

## Android

Two ways to run it on a phone, both from the same codebase:

**1. Install the PWA** — open the live URL in Chrome on Android → menu → **Install app** (or the
**Install app** button in Settings). Standalone icon, offline shell, and Web Push notifications
(Chrome delivers them through FCM even when the app is closed).

**2. Install the native APK** — the signed build is published at
`/download/family-planner-2.1.0.apk` (also linked from Settings → Mobile notifications) and can be
rebuilt locally:

```bash
ANDROID_SDK_ROOT="$LOCALAPPDATA/Android/Sdk" bash android/build.sh
# aapt2 + javac + d8 + apksigner, no Gradle, no network; reads versionCode/versionName
# from gradle.properties and copies the result to web/public/download/ for the next deploy
```

It is a WebView shell around the live planner: cookies persist the PIN session, the back button
walks history, external links open in the browser, and the web app calls
`window.AndroidBridge.notify(title, body)` so every planner alert becomes a real Android
notification (the shell requests `POST_NOTIFICATIONS` on first launch).

The shell URL comes from `plannerApiBaseUrl` in `android/gradle.properties` (via `BuildConfig`), so a
new domain needs no Java change. A WebView shell cannot receive push while it is closed; use the
installed PWA when you want background alerts too.

## Known gaps (not implemented, on purpose)

These are real, tracked gaps rather than silent omissions:

1. **Old household data has not been migrated.** The new database is empty by design; the previous
deployment still holds the old rows and credentials. `migration/` has the toolkit (snapshot → verify →
import), but it needs an owner session cookie from the old site, which only you can produce.
2. **Direct Drive upload needs the owner's Google OAuth client.** The client id is in
   `wrangler.jsonc` and the secret is a Worker secret, so the connector reports `configured: false`
   ("Owner must add credentials") until both are real. Encrypted local backups always work.
3. **Native APK updating is advisory.** `/api/version` can advertise a new build, but serving and
   installing an APK requires a signed release hosted somewhere and `REQUEST_INSTALL_PACKAGES`; the
   shell currently tells the user an update exists and links to it.
4. **End-to-end encryption covers fields and backups, not reports.** Sensitive fields are sealed with
   the Worker's `FIELD_KEY` (so a D1 dump alone is not readable, but the Worker can decrypt in order to
   render totals). True zero-knowledge would move the key to the browser and give up server-side
   aggregation — a deliberate, documented trade-off, not an oversight.
5. **Four roles are fixed, not custom.** Owner/Admin/Editor/Viewer are enforced server-side; there is no
   per-permission custom role editor yet.

Full verification lives in `scripts/smoke.mjs` (API, migration snapshot, headers) and
`scripts/security-test.mjs` (authorisation and isolation, 40 checks).
