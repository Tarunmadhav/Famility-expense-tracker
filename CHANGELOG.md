# Changelog

All notable changes to Family Finance Planner. Versions follow the Android
`versionName`; the API version is separate and only moves when a route changes
shape.

## [2.7.0] - 2026-11-12

Web and Worker release. The Android `versionName` is 2.7.0 (`versionCode` 11) for the
next build; no APK has been built or published for it, and the release row
`/api/version` serves is unchanged.

### Added

- **Tasks have a due time.** A task had only a calendar day, so "6 PM" could not be
expressed: the form had no time input and `sanitizeDoc` drops fields the collection
does not declare. Diary tasks now carry an optional `dueTime` and a derived `dueAt`
(ISO 8601 UTC), which is what reminders compare against. An empty time stays an
all-day deadline.
- **Deadline strip above every screen.** Overdue first, then anything due in the next
24 hours, then anything due later today, each row opening its task. It renders
nothing when nothing is due and never shows an amount.
- **Task reminders through Telegram**, on a new quarterly cron, fifteen minutes
before a task is due, once per task, generic text by default.
- **Settings reports the phone's notification permission** (`notificationState()` on
the Android bridge), so a phone with alerts switched off says so instead of
promising them.
- **Change PIN asks for the new PIN twice.**

### Fixed

- **One alert could be delivered twice.** A write's background drain and the cron
could run at the same time; the loser read the delivery row as merely `pending` and
sent the same alert again. The row now carries a five-minute lease.
- The migration runner is documented in the README, because
  `wrangler d1 migrations list` is not this project's source of truth.

### Migration

- `0010_task_due_at` — an expression index on `json_extract(doc, '$.dueAt')` for the
diary collection. Existing rows are untouched.

## [2.6.0] - 2026-11-12

Web and Worker release. The Android `versionName` is 2.6.0 (`versionCode` 10) for
the next build; the APK at `/download/` is still 2.5.0 until that build is made,
and the `release` row `/api/version` serves is unchanged.

### Added

- **Biometric unlock on Android.** The lock screen asks the system fingerprint or
  face unlock through `BiometricPrompt` (API 28+) or `FingerprintManager`
  (26–27). One prompt at a time, cancelled when the screen changes, a 90 s
  watchdog, and a live session re-check before the planner paints; a cancelled or
  failed prompt falls back to the PIN.
- **One-click webhook registration.** Settings → Notifications → Telegram can
  point the bot at this deployment (`POST /api/telegram/webhook/register`) without
  handling the token, and says whether Telegram is posting here, somewhere else,
  or not at all.
- **Import up to 5000 rows** per file, up from 500 (the 2 MB cap still applies).

### Fixed

- **Google Drive could not be connected.** The provider redirects back with a
  top-level navigation, which sends no `Origin` and `Sec-Fetch-Site: cross-site`,
  so the CSRF check answered `403 Cross-origin request blocked` before the
  callback ran. GET on the OAuth callback paths is now exempt from the origin
  check; every other method and path keeps it, and tests cover both sides.
- **Changing the PIN did not take effect.** The handler rewrote the first account
  in the table instead of the signed-in one, and demanded a permission an account
  with its own PIN does not need. It now updates the caller's row, and explains
  the password-only case instead of failing silently.
- **A valid Telegram link code could be burned by its own "already linked"
  refusal.** The uniqueness check now runs before the code is claimed.
- **`/help` did not list `/start`** — the one command a new user is told to send.
- **A failed Drive consent was unreadable.** The callback now carries the
  provider's reason, so "cancelled" and "not a test user" read differently.
- Saving a Telegram preference dropped the loaded webhook state, which hid the
  "bot is not connected" warning until Settings was reopened.

### Changed

- The UI paints once per animation frame instead of once per state change.
- Settings folds the long AI, Documents and recent-changes sections behind
  `<details>`, and the lock timeout moved into its own sub-section.

## [2.5.0] - 2026-11-11

First release signed with the app's own release key (versionCode 9). APK:
`/download/family-planner-2.5.0.apk`.

### Added

- **CSV and Excel import that works.** Both formats are read in the browser:
  `.xlsx` (shared strings, inline strings, date and money styles) and `.csv`
  (BOM, CRLF, quoted commas and quoted newlines, delimiter sniffing). Wrong
  cells are reported by line and column and nothing is written until every row
  is valid. Limits: 2 MB and 500 rows per file.
- **One Telegram bot instead of WhatsApp.** Alerts, reminders and the daily
  summary go through the bot configured in Settings; the Settings card links
  straight to it, or says which owner secret is still missing.
- **"+ " sheet** with two choices: add one entry, or import a file.

### Changed

- Settings is five groups — Account, Notifications, Backup, Data, About — with
  local downloads for CSV/Excel/JSON.
- Google Drive is the only cloud backup provider; the sign-in screen offers
  Google where it is configured, and names any missing owner secret.
- Dashboard header actions that duplicated the "+" button are gone.

### Fixed

- **File picking never opened on Android.** The WebView had no
  `onShowFileChooser` handler, so import, receipts and backup restore all did
  nothing. The picker now opens, and its pause no longer triggers the app lock.
- **"Continue with Google" never appeared** for a signed-out user: the provider
  list was stored after the early return in the boot sequence.
- **Re-importing a file duplicated every row.** Rows are deduplicated on their
  content, the `+` sheet's manual entry is not.
- **A missing asset was served with `immutable` for a year**, which left the app
  on a blank splash until the cache was cleared.
- Contacts fallback read `.xlsx` files as text; it now parses them like expenses.
- The import wrote rows one statement at a time and could leave a half-imported
  file behind; it is now a single D1 batch.
- Release notes in the update prompt still mentioned WhatsApp reminders.

### Security

- Release builds are signed from `ANDROID_KEYSTORE_*` variables only, never the
  debug key; the build fails before R8 if signing is not configured.
- R8 and resource shrinking are enabled for release, with the rules in
  `android/app/proguard-rules.pro`.
- The release certificate's SHA-256 is registered for App Links alongside the
  emulator debug key.
