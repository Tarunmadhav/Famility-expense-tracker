# Security notes

Audit of the Family Finance Planner (Worker + D1 + R2 + WebView shell) at
commit `c3784c4`, plus the state of each item from the hardening checklist.
Everything marked **verified** was reproduced on the running deployment or in
`wrangler dev`; anything marked **open** is not done and says why.

## Fixed in this pass

### 1. Locking the app destroyed the session (high, correctness + availability)
`onAppHidden()` runs on every Home press and its `lockNow()` called
`POST /api/auth/lock`, which deleted the server session and cleared the cookie.
An account created with email + password has `pin_hash = ''`, so the lock screen
had no PIN that could ever unlock it: closing the app signed the user out and the
next launch demanded a full sign-in. `GET /api/auth/status` also reported
`user: null`, so the client could not tell "locked" from "signed out".

Fix: the lock is enforced on the device (screen replaced, `S.db` dropped, SSE and
polling stopped) and the session is kept. Unlocking calls the new
`POST /api/auth/verify`, which re-checks the signed-in account's PIN or password
without issuing another session. Sign-out and "sign out everywhere" still revoke
server-side.

Verified on the `ffp_test` emulator: sign in → Home → return shows the lock
screen; unlock with the password → dashboard; force-stop → relaunch is still
signed in.

### 2. PIN-only accounts could not sign in or sign up (high, availability)
Planners created before email sign-in have a PIN and no `credentials` row. The
email/password form rejected them (no password exists) and signing up with the
same address answered `409`: both routes the owner tried were dead ends, and
`POST /api/auth/reset` required a `credentials` row that did not exist, so the
documented recovery flow could not run either.

Fix: `/api/auth/reset` attaches the first address and password to an account
that has none, after the PIN check that route already required. An account that
already has an address still has to match it, and an address owned by a different
account is refused with `409`.

Verified in `wrangler dev` with a PIN-only row: reset → `200`, login with the new
address → `200`, wrong PIN → `401`, another account's address → `409`, a second
address for an account that already has one → `401`.

### 3. Bottom tab bar covered the phone UI (high, usability)
Not a security issue but it made the APK look broken: the bare `nav` rule set
`position: sticky; top: 57px` (45px on phones) and the mobile tab bar is a
`<nav>`, so it kept that `top` after a later rule made it `position: fixed;
bottom: 0` and stretched over the whole viewport. Scoped to
`nav:not(.tabbar)`. Verified at 411×914 in Chrome and on the emulator.

## Verified controls

| Control | State | Evidence |
| --- | --- | --- |
| Password hashing | PBKDF2-SHA256, 100 000 iterations (Workers' maximum), 16-byte random salt | `src/store.js` `derivePin()`; hashes are not reversible without the salt |
| Session cookie | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`, token is 32 random bytes, stored server-side with `expires_at` | live `Set-Cookie` header |
| CSRF | every mutating route calls `sameOrigin()`; `Origin` host must match, `Sec-Fetch-Site` must not be cross-site | `POST /api/auth/login` with `Origin: https://evil.example` → `403` |
| CORS | no `Access-Control-Allow-*` is ever emitted, so a cross-origin page cannot read responses | `OPTIONS /api/state` with a foreign origin → `403`, no CORS headers |
| Response headers | CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, COOP/CORP, `Permissions-Policy` | live response headers |
| SQL | D1 prepared statements with bound parameters everywhere; the only interpolations are `PRAGMA table_info(${table})` and `ALTER TABLE ${table}` driven by a fixed internal list | `src/store.js` lines 58-124 |
| Authorisation | route → permission table in `permissionFor()`; every profile-scoped route resolves membership through `profiles.js`; records are keyed by `space`, and the caller's spaces come from the session | `src/worker.js`, `src/profiles.js` |
| Rate limits | login/signup/reset/verify/OTP per IP with lockout, plus a per-user write limit (120/min) | `isLockedOut`, `hitRateLimit` |
| Uploads | MIME sniffed from magic bytes, never from the declared type; reads scoped to the caller's space | `sniffMime()`, `listFiles()` |
| Android bridge | only `notify()` and `platform()`; `notify()` refuses unless the current page is `https` on the deployment host | `MainActivity.onTrustedPage()` |
| Android storage | `allowBackup=false`, `fullBackupContent=false`, `dataExtractionRules` set; file and content access off; `usesCleartextTraffic=false`; `MIXED_CONTENT_NEVER_ALLOW` | `AndroidManifest.xml`, `MainActivity` |
| Dependency audit | `npm audit` → 0 vulnerabilities (the Worker has no runtime dependencies); the APK has **no runtime dependencies at all** (`releaseRuntimeClasspath: No dependencies`), so no third-party library ships in it | 2026-11-09 |
| Build toolchain | Gradle 8.13 → 8.14.6 (CVE-2026-22816, high, dependency resolution); wrapper pinned with `distributionSha256Sum` | 2026-11-09 |

## Open findings

### A. The APK signing key is in the repository (high, open)
`android/debug.keystore` was committed in the first commit and `android/build.sh`
signs every published APK with it using the default passwords `android`/`android`.
Anyone can produce an APK that Android accepts as an update of this app. It is a
signing key, not a data key, so no user data is exposed, but app updates cannot
be trusted until it is replaced.

Replacing it changes the app's signing identity: devices that already have the
app installed will refuse the update until it is uninstalled and reinstalled.
That needs a decision (see the asks at the end) plus a new keystore stored as a
secret and kept out of the repository.

### B. Money is stored as a JSON number, not integer minor units (medium, open)

Backups already export money as integer paise with the unit declared in the
file, so the format question is answered there; the storage migration is still
waiting for approval because it rewrites every record.
Record documents carry `amount` as a JS number (`Number()` in `web/src/format.js`).
Amounts are rounded for display but the stored value is a float, so repeated
sums can drift by paise. Converting to integer paise touches every collection,
the dashboard, charts, exports and the Excel/PDF exporters, and must be a
versioned migration with a rollback — it is not started, and it should not be
half-done.

### C. Legacy `debug.keystore` also means no release signing config (medium)
Same root cause as A: there is no `keystore.properties` or secret-backed release
key. Until it exists, `build.sh` keeps signing with the committed key.

### D. Email verification and password reset by email are unconfigured (medium)
`GET /api/auth/status` reports `"email": false`. `POST /api/auth/otp/request`
answers `501` naming `RESEND_API_KEY`, so nothing pretends a message was sent, and
the forgot-password screen now says so explicitly. Sign-up does not verify the
address at all. Both need an email provider.

### E. Social sign-in has no provider credentials (blocked)
The flow itself is implemented and tested: PKCE S256, single-use state, the
provider page opened in the system browser, a one-time ticket handed back through
an App Link, and one documented account-linking rule keyed on a confirmed
address (`docs/OAUTH.md`). What is missing is the credentials: every provider
reports `configured: false`, so the buttons stay hidden. Nothing about the flow
depends on them, but it cannot be exercised end to end until they exist.

### F. Cloud backup has no provider credentials (blocked)
Same shape: Google Drive (`drive.appdata`) and OneDrive
(`Files.ReadWrite.AppFolder`) are implemented with PKCE, refresh tokens sealed by
AES-256-GCM under `BACKUP_KEY`, a versioned checksummed export, an all-or-nothing
restore, and a cron trigger that is off per account by default. The signing of
those requests needs client ids and secrets that do not exist yet, and
`BACKUP_KEY` has to be generated and set before any drive can be connected.

### G. `users` invariants are triggers rather than CHECK constraints (low)
Every other table now carries real foreign keys and CHECK constraints (migration
`0002_constraints`). `users` is the exception: every other table cascades from
it, so dropping it to rebuild would delete the rows the migration just copied,
and it keeps its column rules in `BEFORE INSERT/UPDATE` triggers instead. The
effect is the same; the mechanism differs.

### H. `scripts/security-test.mjs` and `scripts/smoke.mjs` are not wired into CI
They run against a live URL with the owner's PIN; CI only runs the smoke check.

## Fixed since the first audit

- **Locking the app emptied the WebView but kept the session**, and `pin_hash`
  accounts could never unlock it; the unlock path now re-checks the secret
  instead of revoking the session.
- **A PIN-only planner could not add an email** and could not sign in at all.
- **The tab bar covered the screen** because the mobile `nav` rule leaked onto
  the bottom bar.
- **The schema had no foreign keys, checks or migration history**, and
  `ensureSchema()` created tables at boot. Replaced by
  `src/migrations/` (`0001_baseline`, `0002_constraints`) with tests that apply
  the chain to an empty database and upgrade a v12 fixture without losing a row.
- **Cloud refresh tokens were stored in clear text** and the Google scope was
  `drive.file` (the whole drive). Now `drive.appdata` /
  `Files.ReadWrite.AppFolder` and AES-256-GCM at rest.
- **Social sign-in had no PKCE and ran inside the WebView**, and linked accounts
  on provider identity alone. Rebuilt, with the rule written down.
- **Gradle 8.13 was affected by CVE-2026-22816** (high, dependency resolution);
  upgraded to 8.14.6 and the wrapper now verifies the distribution hash.

## Asking for

1. Google OAuth (web client ID + secret, Android client ID, signing SHA-1,
   redirect URIs) — sign-in and Drive backup.
2. Facebook app ID + secret, key hash, redirect URIs.
3. Microsoft Entra app registration (client ID, secret, redirect URIs).
4. Permission to generate a new Android release keystore and store it as a
   secret, accepting that existing installs must be reinstalled once.
5. An email provider (Resend/SendGrid/SMTP) and its API key.
6. Product decisions: Apple sign-in, multiple owners per household, whether
   linked logins share one book, and backup frequency/retention.
