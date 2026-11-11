# Changelog

All notable changes to Family Finance Planner. Versions follow the Android
`versionName`; the API version is separate and only moves when a route changes
shape.

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
