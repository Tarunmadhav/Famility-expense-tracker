# MIGRATION AUDIT — Family Finance Planner

Status: **audit only, nothing changed.** No infrastructure action has been taken.
Audited commit: `b3c2f36` on branch `main` (68 tracked files), working tree clean.
Live site checked: `https://site-0f6d51dc534d4dd4af419f3a4cf5f0ad.freebuff.page`
(`/api/health` → `{"ok":true,"database":true,"assets":true}`, `/api/auth/status` →
`{"configured":true,"user":null,"push":true,"signupOpen":true}`).

Every finding below was read from the repository or queried live. Items I could not
verify are listed as **UNKNOWN** or **ASSUMED** — none are presented as fact.

---

## 1. What the application is

| Layer | Reality |
| --- | --- |
| Frontend | Vanilla ES modules, no framework, bundled by **Vite 7** (`vite.config.js`, entry `web/index.html`, sources `web/src/*.js`) |
| Backend | One **module Worker**, no framework: `src/worker.js` (single `fetch` handler; `/api/*` → API, everything else → static assets) |
| Bundle | `npm run build` → `scripts/build.mjs` → `dist/` (web + PWA) and `build/worker.js` + `build/static/` |
| Data | **D1** binding `DB`, **R2** binding `FILES`, secret `FIELD_KEY` |
| Realtime | Server-Sent Events at `/api/events` using a `ReadableStream` in the Worker (F, no Durable Object) |
| Mobile | Android **WebView shell** (`android/`), Gradle 8.13 / AGP 8.13.2, `applicationId com.family.planner` |

Verified: no `nodejs_compat`, no native addons, no Node-only API in `src/` — the Worker
uses WebCrypto, `fetch`, D1 and R2 only. This matters because it means the app is
**portable to a plain Cloudflare account without a Workers adapter** (no OpenNext/Next.js
involved).

---

## 2. API surface (all routes verified in `src/worker.js`)

Public: `/api/health`, `/api/auth/status`, `/api/auth/setup`, `/api/auth/signup`,
`/api/auth/login`, `/api/auth/logout`, `/api/auth/lock`, `/api/push/key`.
Authenticated: `/api/state`, `/api/records` (GET/POST/PATCH/DELETE), `/api/records/bulk`,
`/api/export`, `/api/files` (GET/POST), `/api/files/:id` (GET/DELETE),
`/api/activity`, `/api/notifications`, `/api/notifications/read`, `/api/push/subscribe`,
`/api/push/unsubscribe`, `/api/push/test`, `/api/settings`, `/api/family/members`,
`/api/family/invite`, `/api/auth/account`, `/api/auth/password`, `/api/auth/pin`,
`/api/auth/sessions`, `/api/auth/sessions/revoke`, `/api/ai/connections`,
`/api/scan`, `/api/events` (SSE). Owner-only: `/api/admin/reset`, `/api/admin/clear`,
`/api/admin/sample`.

Business collections (8, `web/src/entities.js`): `contacts`, `family`, `expenses`,
`subscriptions`, `payments`, `loans`, `insurance`, `diary`.

---

## 3. Database

- Schema version: **8** — `src/store.js:9` (`SCHEMA_VERSION = '8'`), stored in `meta.k='schema'`.
- Tables (`src/store.js:18–36`): `meta`, `users`, `sessions`, `records`, `changes`,
  `notifications`, `push_subs`, `auth_fails`, `credentials`, `files`, `ai_connections`,
  `family_invites`, `rate_limits`.
- **There is no `migrations/` directory**, yet `wrangler.jsonc` declares
  `"migrations_dir": "migrations"`. Schema creation/migration happens **at runtime** in
  `ensureSchema()` → `migrateSpaces()` / `migrateV6()` via `CREATE TABLE IF NOT EXISTS`
  plus guarded `ALTER TABLE ... ADD COLUMN`. Consequence: a fresh database needs no
  migration commands; the first request creates the schema. `wrangler d1 migrations`
  commands would fail against this repo — do not put them in the migration scripts.
- Space model: every data table carries `space` (`family`, `personal`, `office`) and
  `users.household` scopes the family book (`spaceFor()` in `src/worker.js`).
- Size on the current host (from the hosting console): **~457 KB, 13 tables, 1 household**.

---

## 4. Authentication and sessions

| Item | Verified value | Location |
| --- | --- | --- |
| PIN hashing | PBKDF2-SHA256, **100 000 iterations**, per-user salt | `src/store.js:12`, `createUser`/`verifyPin` |
| Password hashing | PBKDF2, same iteration count, separate `credentials` row | `src/store.js:276–324` |
| Session storage | `sessions` table, opaque random token, **30 days** | `src/store.js:13`, `createSession` |
| Cookie | `ffp_session`, `HttpOnly; Path=/; SameSite=Lax; Max-Age=…`, `Secure` on https | `src/worker.js:205–212` |
| Threat controls | per-IP failure lockout (`auth_fails`), `rate_limits` table, write limiter | `src/store.js:557+`, `src/worker.js` |
| Roles | `users.role` = `owner` / `member`; invites inherit role + household | `src/store.js:54, 347–398` |
| Signup | open; code optional → new household `h:<userId>` | current `main` |

All hashes move with the database, so **accounts keep working after migration with no
password reset** — provided the `credentials` and `users` tables are copied verbatim.

---

## 5. Field encryption (the highest-risk item)

- `src/fieldcrypto.js`: AES-256-GCM, key from secret **`FIELD_KEY`** (base64, exactly 32
  bytes), ciphertext format `enc1:<iv b64>:<ciphertext b64>`.
- Encrypted fields are listed in `SECRET_FIELDS` (phone/email/notes/remarks on contacts,
  family, payments, insurance, expenses, diary, loans, subscriptions).
- Rows written before the key existed stay plaintext and still read (non-destructive
  rollout). Rows written after it was set are **unreadable without the exact key**.
- The key was set on the current host on **2026-11-03 16:34 UTC** (hosting operation log),
  so anything entered since then is ciphertext.
- The key is **not** in the repository, not in `.env`, and I have not read its value.

`ASSUMED`: the key is a randomly generated 32-byte value that exists only as that hosting
secret. If it is lost, all `enc1:` values become permanently unreadable. **It must be
exported to your own password manager before any cutover, never regenerated.**

---

## 6. File storage

- Binding `FILES` → R2. Object key pattern: `drive/<uuid>.<ext>` (`src/worker.js:564`),
  generated server-side per upload; the matching row lives in `files`
  (`id, space, name, mime, size, key, collection, record_id, uploaded_by, created_at`).
- Limits: images/PDF only (content-sniffed), max **8 MB** per file.
- Current host reports **R2 storage used: 0 bytes**, 5 write ops and 13 read ops lifetime
  → almost certainly **no live objects** (uploads that were later deleted).
- Consequence: keys are UUID-based, so a key-preserving copy needs direct R2 write
  access. Re-uploading through `/api/files` would mint **new** UUIDs and new rows.
  `UNKNOWN` until counted: the actual number of objects and `files` rows.

---

## 7. Notifications, push, AI

- **Web Push**: RFC 8030/8291 implemented in `src/push.js` with WebCrypto, no dependency.
  VAPID keypair is generated once and stored in **D1 `meta.k='vapid'`** — so it travels
  with a database dump and existing browser subscriptions keep working.
  Subscriptions live in `push_subs`.
- **Android notifications**: no FCM. `MainActivity` exposes
  `window.AndroidBridge.notify(title, body)`; the web app calls it. Nothing to re-key.
- **AI**: `/api/scan` calls any OpenAI-compatible endpoint configured in D1
  (`ai_connections`: `provider, base_url, model, api_key`). There is **no AI key in the
  environment**; keys are per-household rows in the database.
  ⚠️ Finding: `ai_connections.api_key` is stored **in plaintext** (not passed through
  `fieldcrypto`). Recommend encrypting this column after the migration; not changed now.
- **Email**: none. No provider, no outbound mail code anywhere in `src/`.

---

## 8. Android app

- Production URL: `plannerApiBaseUrl` in **`android/gradle.properties:8`** →
  `buildConfigField PLANNER_URL` → `BuildConfig.PLANNER_URL` in `MainActivity`.
- Host allowlist: `MainActivity.shouldOverrideUrlLoading` keeps navigation inside the
  WebView only when `host.endsWith("freebuff.page")`; every other link opens the external
  browser. **This must change for a custom domain** (or all in-app links will bounce out).
- Identity: `applicationId "com.family.planner"`, namespace same, `minSdk 26`,
  `targetSdk 35`, `compileSdk 36`, `versionCode 1`, `versionName 2.0`.
- Signing: release is signed **only** from `ANDROID_KEYSTORE_PATH/PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; `requireReleaseSigning` fails the build
  otherwise. `android/SIGNING.md` documents `keytool`. No keystore is in the repo.
- `UNKNOWN`: whether a release keystore exists yet. CI reports `signing-ready=false`, so
  the signed release job has always been skipped — **no published Play listing signature
  to preserve**, which makes changing hosts low-risk.

---

## 9. Build, deploy and CI

| File | Role |
| --- | --- |
| `scripts/build.mjs` | Vite build → `dist/`, esbuild Worker bundle → `build/` |
| `deploy.json` | **Freebuff Sites deploy manifest**: `entrypoint worker.js`, `assetsDirectory ./build/static`, `spa: true` |
| `wrangler.jsonc` | Local dev only: `name family-finance-planner`, `compatibility_date 2025-09-01`, `assets.run_worker_first true`, `DB` with **placeholder `database_id` `0000…`**, `FILES` bucket `family-planner-drive`, observability on |
| `.github/workflows/ci.yml` | `npm ci`, `npm audit`, build, start `wrangler dev --local`, run 76-check suite. **No deploy job** — comment says deployment stays manual via Freebuff Sites |
| `.github/workflows/android-apk.yml` | test → security (gitleaks) → signing-ready → build-apk/upload/release |
| `scripts/smoke.mjs` | 76 end-to-end checks against a local Worker |
| `ops/` | Oracle **backup/uptime only** (no app hosting): `backup-d1.sh` uses `wrangler d1 export --remote` + `age` |

`wrangler.jsonc` is **not** used for production today and its `database_id` is a zeroed
placeholder, so `wrangler deploy` from this repo would not hit the live database. That is
good news: the repo has no production binding wired in.

---

## 10. Where the app actually runs today (verified from the hosting console)

```
Cloudflare account id : 6e5a40dd9362fb315de7ecbaad2ca12b
Workers namespace     : freebuff-sites-prod        <-- Freebuff-managed
Worker name           : site-0f6d51dc534d4dd4af419f3a4cf5f0ad
D1  (binding DB)      : 4f25d689-3867-4071-9d85-c23a3c9f6050
                        resource site-8bcdb5c7b01a45b4833c738eb1d20b9d
R2  (binding FILES)   : site-addf0669af0b4e27ac6c8ce56284bb7d
Secret FIELD_KEY      : set 2026-11-03 (value not readable by me or by you in the UI)
Publication           : published, last deploy 2026-11-04T08:51Z
```

The namespace name `freebuff-sites-prod` and the `site-<hash>` resource names indicate
these resources are created and owned by the hosting platform inside that account, not by
a human. **Whether you can sign in to that account id is the single most important unknown
in this whole migration** (see Risk 1).

---

## 11. Secrets and configuration required in the destination

| Name | Kind | Source today | Transferable? |
| --- | --- | --- | --- |
| `DB` | D1 binding | platform-provisioned | re-created in your account |
| `FILES` | R2 binding | platform-provisioned | re-created in your account |
| `FIELD_KEY` | secret | hosting secret, set 2026-11-03 | **must be exported and re-set verbatim** |
| VAPID keypair | D1 `meta` row | generated at runtime | travels with the database |
| `ai_connections.*` | D1 rows | created in the app UI | travels with the database (plaintext today) |
| `ANDROID_KEYSTORE_*` | GitHub secrets | not set yet | nothing to transfer; you create one |
| `CLOUDFLARE_API_*` | your tooling | none in repo | you create a scoped API token for the new account |

No `OPENAI_API_KEY`, no mail provider key, no VAPID env var, no `nodejs_compat` flag.

---

## 12. Migration risks, in priority order

1. **Database export path.** `wrangler d1 export --remote` needs Cloudflare API
   credentials **for account `6e5a40dd…`**. If you cannot sign in to that account, there is
   no official D1 export for this project. The app's own `/api/export` is **insufficient**
   — it returns only the 8 business collections plus `settings`; it omits `users`,
   `credentials` (password hashes), `sessions`, `files`, `push_subs`, `notifications`,
   `ai_connections`, `family_invites`, `changes`, `meta`. Using it would migrate the
   ledger but **lose every account and every uploaded-file reference.** The realistic
   fallback is a temporary owner-only snapshot route inside our own Worker (we own that
   code), which you would approve before it is deployed and delete afterwards.
2. **FIELD_KEY.** Encrypted fields are unrecoverable without the exact 32-byte key. It
   cannot be displayed in the hosting UI, so it must be exported through a channel we
   control while the current host still runs. Losing it silently corrupts phone numbers,
   emails and notes.
3. **Sessions and cookies.** A new origin means the old `ffp_session` cookie is not sent
   to the new host. Plan: copy sessions **or** accept a forced re-login (I recommend
   forcing re-login — cleaner and invalidates nothing else). PIN and passwords keep
   working either way because the hashes move.
4. **Android host allowlist.** `host.endsWith("freebuff.page")` in `MainActivity` must
   include the new host, and the APK must be rebuilt — an existing installed APK cannot be
   pointed at a new URL without a new build.
5. **R2 key preservation.** Object keys are UUIDs; a byte-copy of the bucket preserves
   them, an HTTP re-upload does not. Current usage suggests zero objects, so this may be
   free — but it must be counted, not assumed.
6. **SSE on your own account.** `/api/events` keeps one long-lived request open per client
   with a polling loop. This works on Workers but is duration/CPU sensitive; verify it on
   the destination, and if it misbehaves the fix is client polling (behaviour change) or a
   Durable Object (new component). Flagged now so it is not a surprise at cutover.
7. **`wrangler.jsonc` placeholders.** A real `database_id` and bucket name must be written
   for the destination, or `wrangler deploy` fails or silently creates new resources.
8. **Two login surfaces.** Owner PIN login resolves the first user with a PIN
   (`verifyPin` filters `length(pin_hash) > 0`); if other accounts also have PINs, the PIN
   login is ambiguous by design today. Not a migration blocker, but test it explicitly.
9. **Plaintext AI keys** in `ai_connections` — a security finding to fix after the move.

## 13. Things I could not verify (do not assume)

- Whether you can sign in to Cloudflare account `6e5a40dd…`.
- The FIELD_KEY value (by design — and it must stay out of chat). Whether it is 32 valid
  bytes: only provable by encrypting/decrypting after import.
- Row counts per table, live `files` count, live `push_subs` count.
- Whether live production data equals `main` (deploys succeeded, but data is data).
- Whether a release keystore exists.
- Whether the current host offers any bulk export/download capability at all.

## 14. Recommendation

Cloudflare remains the right target — the app is already 100% Workers-compatible, so no
framework adapter, container or runtime rewrite is needed, and every feature (D1, R2,
secrets, SSE, push) exists in a personal account. Oracle is **not** recommended: it would
require re-hosting the Worker runtime entirely.

Order of work: prove the two risky items first (database export + FIELD_KEY export), on
copies, before touching anything about the live site. Everything else is mechanical.
