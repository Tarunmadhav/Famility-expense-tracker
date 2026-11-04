# FAMILY FINANCE PLANNER — PROJECT MEMORY & MIGRATION HANDOFF
_Last updated: 4 November 2026_

This file is a handoff note for future ChatGPT conversations or another developer.
It records the known project architecture, migration goal, confirmed facts, risks,
open questions, and next actions. It is not a credential store.

## 1. Project identity

- Project: Family Finance Planner / Famility Expense Tracker
- GitHub repository: https://github.com/Tarunmadhav/Famility-expense-tracker.git
- Existing live website:
  https://site-0f6d51dc534d4dd4af419f3a4cf5f0ad.freebuff.page
- Existing preview:
  https://site-d5cebd755082457297c63980e1b24526.freebuff.page
- Android package: `com.family.planner`
- The Android app is a WebView shell that loads the hosted website; it does not bundle the full website.
- Main goal: move ownership/management away from the Freebuff-managed free tier into the user's own Cloudflare account, while preserving the application, accounts, data, files, authentication, and Android experience.
- User wants beginner-friendly instructions and as much migration automation as safely possible.
- User is using Windows and needs PowerShell-oriented steps.
- User has said the complete codebase is in GitHub.

## 2. Important clarification about the current host

The user corrected an earlier misunderstanding: the current application is managed by **Freebuff**, not Firebase or Supabase.

The project documentation and code indicate that the application already uses Cloudflare technology:
- Cloudflare Workers for API/backend.
- Cloudflare D1 for SQL database.
- Cloudflare R2 for uploaded files.
- Cloudflare-compatible deployment configuration.
- Freebuff currently provides the managed hosting/deployment experience and live project environment.

Therefore, the recommended direction is to deploy the existing Cloudflare-based architecture into a Cloudflare account owned by the user, rather than rewrite it for Oracle Cloud.

Do not assume Freebuff exposes direct Cloudflare dashboard access, export credentials, D1 export, or R2 S3 credentials. These must be confirmed with the user/platform.

## 3. Application architecture (from uploaded project documentation)

### Frontend and backend
- Frontend: vanilla JavaScript ES modules + Vite (`web/`).
- Backend: single Cloudflare Worker module (`src/worker.js`); related store logic in `src/store.js`.
- Worker serves API and application assets.
- Build produces frontend assets and Worker bundle.
- Project documentation describes `npm run build`, `npm run dev:api`, `npm run dev`, and `npm run smoke`.

### Database
- Cloudflare D1 binding: `DB`.
- D1 stores application records, users, credentials, sessions, changes, notifications, push subscriptions, file metadata, AI connections and other supporting data.
- Main record table: `records(collection, id, doc JSON, rev, updated_at, updated_by)`.
- Application collections documented include:
  `family`, `contacts`, `subscriptions`, `expenses`, `payments`, `loans`,
  `insurance`, `diary`, `budgetIn`, `budgetEx`.
- Supporting tables documented include:
  `users`, `credentials`, `sessions`, `changes`, `notifications`,
  `push_subs`, `files`, `ai_connections`.
- A `changes` table tracks global revisions for live-sync diffs/activity.
- Uploaded older setup guide says schema version 7; a later inspection of GitHub source reported schema version 8. This discrepancy must be resolved against the live deployment before migration.

### File storage
- Cloudflare R2 binding: `FILES`.
- Bucket name in earlier docs: `family-planner-drive`.
- Uploaded documents include bills, receipts, policy documents; docs state an 8 MB limit and accepted types JPEG/PNG/WebP/PDF.
- File metadata is also in D1, and object keys must be preserved during transfer.
- Database JSON export alone is not a full backup and does not include all R2 object bytes.

### Authentication and security
- Owner can unlock with a family PIN; other members can register/sign in with email and password.
- Password hashing documented as PBKDF2-SHA256 with per-user salt.
- Sessions use random tokens; only hashes are stored; cookie is HttpOnly, SameSite=Lax, Secure on HTTPS.
- Login rate limiting is documented.
- Sensitive fields are encrypted using AES-256-GCM with Worker secret `FIELD_KEY` (32 random bytes, base64).
- **The original production `FIELD_KEY` is essential.** A new random key cannot decrypt existing encrypted fields.
- Never ask the user to paste `FIELD_KEY`, passwords, Cloudflare API tokens, or storage secrets into chat.
- User must preserve the original key securely and set it as a Worker secret in the destination environment.
- Existing password hashes may be transferable if the schema and hash implementation are compatible; do not promise successful account migration until verified.
- Sessions should generally be invalidated/recreated at cutover, rather than blindly copying active sessions, unless compatibility is proven.

### Multi-book model and access control
- Three books: Family, Personal, Office.
- Family book shared within a household.
- Personal and Office are private to the signed-in user.
- Server derives household and book scope from session; client header selects book but must not be trusted for authorization.
- Office book is intentionally restricted to selected collections.
- Membership invite codes are one-time and time-limited according to docs.
- Preserve server-side authorization boundaries during migration.

### Live sync and notifications
- Live sync uses Server-Sent Events (`/api/events`) and revision-based diffs (`/api/state?since=...`), plus a periodic safety poll.
- Notifications include bills due, insurance renewals, tasks, birthdays, and budget overspend.
- Web Push uses VAPID and encrypted payloads; in-app notifications are also present.
- Android shell has an `AndroidBridge.notify(title, body)` hook for native notifications.
- Web Push on an installed PWA may work differently from a WebView APK; test both.

### AI integration
- Settings supports OpenAI-compatible AI providers.
- API keys are stored server-side in D1 and not returned by API.
- Bill scanning can send receipt images to configured vision model.
- AI connections and provider keys require careful secure migration or manual re-entry; do not export secrets into Git.

## 4. Android details

- Android package: `com.family.planner`.
- Android app is a thin WebView wrapper around the live website.
- `MainActivity.START_URL` or the repository's Gradle property may determine the site URL; inspect current GitHub source before editing.
- The Android host allowlist reportedly treats `freebuff.page` as an internal host. When changing to a `workers.dev` or custom domain host, update the internal-host check to include the exact new hostname, or navigation may leave the WebView.
- Existing APK signing keystore must be preserved if users need seamless app updates. If lost, Android may reject an update signed with a different key unless the old app is uninstalled.
- Do not change signing config or overwrite keystore.
- Build a test APK first, verify app opens new URL and existing session/data, then produce release APK with same signing key.

## 5. Repository and local development

Repository:
https://github.com/Tarunmadhav/Famility-expense-tracker.git

Project files described in documentation:
- `web/` — frontend.
- `src/worker.js` — Worker/API.
- `src/store.js` — database/schema/store logic.
- `src/push.js` — push notifications.
- `android/` — Android shell/build.
- `deploy.json` — Freebuff/Sites deployment manifest in prior docs.
- `wrangler.jsonc` — Cloudflare configuration.
- `package.json` and `package-lock.json`.
- `.github/workflows/` — CI workflows.

Local setup documented:
```powershell
node -v
npm -v
git --version
npm ci
npm run build
npm run dev:api
npm run smoke
```

The uploaded project guide says Node.js 22 and JDK 17; Android build also needs Android SDK platform/build-tools configured. Confirm current repository instructions because docs/source may have changed.

Earlier source review reported:
- `wrangler.jsonc` includes D1 binding `DB` with a placeholder database ID (`00000000-0000-0000-0000-000000000000`) in the inspected revision.
- R2 binding name is `FILES`, with bucket name previously shown as `family-planner-drive`.
- `package.json` already includes Wrangler, so installing it separately should not be necessary.
- Confirm current files before making any edit; GitHub main may have changed since inspection.

## 6. Migration strategy recommended

Preferred target: **user-owned Cloudflare account**, retaining Workers + D1 + R2.
Do not migrate to Oracle unless a later technical/business requirement justifies a redesign.

Migration sequence:
1. Inventory exact production Freebuff resources and deployed code version.
2. Clone GitHub repository locally and run checks/build.
3. Preserve an immutable copy of repository and current deployment details.
4. Securely obtain original `FIELD_KEY`.
5. Export full production D1 database in a format suitable for restore.
6. Export all R2 objects, preserving exact object keys.
7. Create destination Worker, D1 database and R2 bucket in user's Cloudflare account.
8. Configure `DB` and `FILES` bindings and environment variables/secrets.
9. Import D1 data and transfer R2 objects.
10. Validate schema version and migration/initialization behavior.
11. Test login, password authentication, PIN lock, membership, all books, encryption/decryption, records, files, live sync, push notifications, AI settings.
12. Deploy to a temporary/new hostname first.
13. Update Android URL and internal-host allowlist; build and test debug APK.
14. Cut over custom domain or production URL only after verification.
15. Keep Freebuff running and untouched until the new environment has passed acceptance tests.
16. Take final backups and only then decide whether to retire Freebuff.

## 7. Critical migration cautions

- GitHub contains source code, not the live D1 database, live R2 object contents, production Worker secrets, or necessarily the exact deployed build.
- In-app JSON backup is not a complete infrastructure migration. It may omit credentials, sessions, change log, push subscriptions, file metadata, AI connection data, and other system tables.
- Full D1 export and R2 object export are separate operations.
- Preserve R2 object keys because D1 file metadata references them.
- Preserve the original `FIELD_KEY`.
- Do not overwrite a destination database without a backup and explicit confirmation.
- Do not run destructive SQL or delete the Freebuff environment.
- Do not assume `wrangler deploy` alone is compatible with the existing `deploy.json`/Freebuff Sites deployment workflow. Inspect `wrangler.jsonc`, `deploy.json`, `package.json`, scripts, Worker entry point and current Cloudflare deployment format before changing deployment method.
- A PowerShell helper script was drafted earlier, but it has not been validated against the actual current repository configuration or Freebuff export mechanism. Treat it as a starting helper, not a production-ready one-click migration. In particular, JSONC parsing, deployment config, D1 schema/import compatibility and R2 bulk transfer need verification before running provisioning/import/deploy stages.
- The source docs mention a default PIN `135790`. If it is active, change it. Avoid publishing operational PINs in README.
- Never expose secrets in screenshots or chat.

## 8. Questions still required from the user

Ask one at a time or in a compact checklist; explain where to find the answer.

1. Can the user log in to the Freebuff project dashboard?
2. Does Freebuff provide a full D1 SQL export, SQLite file download, or another database export? If none, what database console/export options are visible?
3. Can Freebuff export/download all R2 bucket objects? Does it provide S3-compatible endpoint/access credentials or a downloadable archive?
4. Does the user have access to production Worker/Sites secrets and the original `FIELD_KEY`? Answer yes/no/not sure; never request the actual value.
5. Has the user created their own Cloudflare account?
6. Is GitHub `main` exactly the code currently deployed on Freebuff, or are there changes only in Freebuff?
7. Does the user own/use a custom domain, or should the first destination use `workers.dev`?
8. Does the user have the original Android release keystore and passwords? Never request passwords in chat; just establish whether they have them.
9. What deployment features are available in Freebuff (download project, database console, storage browser, secrets panel, deployment logs)?

## 9. Current user-facing progress

- User provided GitHub repository URL.
- User requested an automation script and beginner instructions.
- A PowerShell migration helper and text guide were generated in the prior conversation, but user reported inability to download them.
- Need resolve delivery issue by creating one ZIP bundle containing the script, guide and this memory file, and preferably also provide the memory file separately.
- User explicitly requested a detailed memory file. This document fulfils that request.
- Next best response: provide the ZIP and standalone Markdown as actual generated attachments; then ask the user to confirm whether they can access/download the files and start with Freebuff dashboard/export questions.
