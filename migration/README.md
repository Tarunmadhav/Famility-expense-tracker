# Migration toolkit — Family Finance Planner → your own Cloudflare account

You are moving a **working app with real family financial data** to infrastructure you own.
Nothing here rewrites the app. The risk is in the data, so the toolkit is built around
proving the data arrived intact before anything is switched.

## Read in this order

| File | Why you care |
| --- | --- |
| `MIGRATION_AUDIT.md` | What the app actually is, verified from code — plus the one blocker |
| `MIGRATION_PLAN.md` | Target architecture, the export decision, the 10 phases |
| `MIGRATION_INTAKE.md` | Your answers, and what is still open |
| `CLOUDFLARE_SETUP.md` | Account, `workers.dev` subdomain, API token, resources |
| `BACKUP_GUIDE.md` | The two artefacts that must not be lost, and the restore test |
| `DATABASE_MIGRATION.md` | How data is exported, converted and imported (and 3 failure modes) |
| `STORAGE_MIGRATION.md` | Why object keys must be preserved, and how |
| `SECURITY_CHECKLIST.md` | Secrets, tokens, snapshot handling, post-cutover hardening |
| `CUTOVER_PLAN.md` | The 9 ordered steps, with the write freeze |
| `ROLLBACK_PLAN.md` | What to do at each failure point |
| `MIGRATION_CHECKLIST.md` | The gate list; every risky step needs your approval |

## Scripts

| Command | Effect |
| --- | --- |
| `.\migration\migrate.ps1 -Step Check` | Tools, Cloudflare login, git state, key file, config. Read-only. |
| `.\migration\migrate.ps1 -Step Export` | Owner login → full snapshot → `.sha256`. Read-only on the source. |
| `.\migration\migrate.ps1 -Step Sql` | Snapshot → chunked `INSERT OR REPLACE` files. Local. |
| `.\migration\migrate.ps1 -Step DbCreate` | Creates your D1 + R2, records the ids. |
| `.\migration\migrate.ps1 -Step Import` | Loads the SQL into your D1. Additive; re-runnable. |
| `.\migration\migrate.ps1 -Step Storage` | Copies files with their original keys. |
| `.\migration\migrate.ps1 -Step Secret` | Applies `FIELD_KEY` from the file, never printed. |
| `.\migration\migrate.ps1 -Step Deploy` | Publishes the Worker on your account. |
| `.\migration\migrate.ps1 -Step Health` | Checks `/api/health` and `/api/auth/status`. |
| `.\migration\verify-migration.ps1 -Step All -Credentials` | Counts, key, files, login. |
| `node migration/snapshot-tool.mjs …` | `counts` / `sql` / `list-files` / `decrypt-check`. |

Add `-DryRun` to any `migrate.ps1` step to see the exact commands without running them.
Every step exits non-zero on failure and says what to do next; a step never continues past
an error.

## First run, from zero

```powershell
# 1. see what is missing
.\migration\migrate.ps1 -Step Check

# 2. copy the config and fill in worker name + expected URL
Copy-Item migration/migration.config.example.json migration/migration.config.json

# 3. authenticate (either way)
npx wrangler login
# or: set $env:CLOUDFLARE_API_TOKEN as described in CLOUDFLARE_SETUP.md

# 4. create your resources
.\migration\migrate.ps1 -Step DbCreate
```

Everything after that is gated: `MIGRATION_CHECKLIST.md` marks each risky action
**[APPROVAL]**.

## Rules this toolkit follows

1. The source deployment is never modified, unpublished or deleted.
2. The import is additive (`INSERT OR REPLACE`) — it cannot delete rows.
3. No script prints, logs or commits a secret; `FIELD_KEY` travels as stdin from a
   git-ignored file.
4. `-DryRun` exists for every step that changes something.
5. A step that fails stops; nothing is retried in a loop (which is how lockouts and
   duplicate rows happen).
6. Verification compares rows, bytes and hashes — not HTTP status codes.

## What is explicitly not automated

- Creating your Cloudflare account or API token (browser steps, yours).
- Creating the Android keystore (`keytool`, documented in `android/SIGNING.md`; never done
  for you).
- Deleting anything, ever.
- Choosing the cutover window.

## Requirement check

| Requirement | How it is met |
| --- | --- |
| Workers, D1, R2, static assets, existing auth, secrets, Android | mapped in `MIGRATION_PLAN.md` §2 |
| No rebuild, no feature removal, no schema change | §2 and §5 of the plan |
| Beginner-friendly, one step at a time | `migrate.ps1` steps + this README |
| No fabrication about platform APIs | `MIGRATION_AUDIT.md` §10 and the export decision in the plan §3 |
| Backups before import | `BACKUP_GUIDE.md`, rehearsal in Phase 4 |
| Approval before production changes | `MIGRATION_CHECKLIST.md` **[APPROVAL]** gates |
| Tests beyond HTTP 200 | `verify-migration.ps1` + `CUTOVER_PLAN.md` steps 5–6 |
