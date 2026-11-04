# MIGRATION_CHECKLIST

Tick as you go. A box marked **[APPROVAL]** must not be done without an explicit "go" from
the owner in chat. Boxes marked *(me)* are mine to do; *(you)* are yours.

## Phase 1 — Audit ✅
- [x] *(me)* Read every source file that defines runtime behaviour, schema, auth, storage, CI, Android.
- [x] *(me)* Query the live deployment's health and auth status.
- [x] *(me)* Verify which Cloudflare account holds the resources.
- [x] *(me)* Write `MIGRATION_AUDIT.md` with verified vs unknown findings.

## Phase 2 — Interview ✅
- [x] Hosting access → no access to the platform account → in-app export path.
- [x] Own Cloudflare account → verified, Workers/D1/R2 available.
- [x] Address → no domain → `*.workers.dev`.
- [x] `FIELD_KEY` → backed up in the password manager.
- [x] Owner login → works (both PIN and email+password).
- [x] Stored files → "a few (1–5)" but host reports 0 bytes → verify from `files` rows.
- [x] Accounts → owner + one member.
- [x] Android keystore → none yet; create during the Android phase.
- [x] Cutover window → decide later.

## Phase 3 — Snapshot route (code, on a branch)
- [ ] *(me)* Add `GET /api/admin/snapshot` (owner-only, read-only, keyset-paginated).
- [ ] *(me)* Add tests: 401 signed out, 403 as member, 200 as owner, counts non-zero, no writes.
- [ ] *(me)* Run the full local suite (`npm run build`, wrangler dev, `npm run smoke`) — must stay green.
- [ ] *(me)* Show you the diff and explain it line by line.
- [ ] **[APPROVAL]** *(you)* approve deploying it to preview.

## Phase 4 — Preview rehearsal
- [ ] *(me)* Deploy the branch to the preview environment.
- [ ] *(me)* Export a snapshot from preview; convert to SQL; import into a scratch D1 in your account.
- [ ] *(me)* Verify counts and key against that scratch database.
- [ ] *(me)* Report the numbers; delete nothing.

## Phase 5 — Destination resources
- [ ] *(you)* Set the API token (or `npx wrangler login`) — `migrate.ps1 -Step Check` all green.
- [ ] *(me)* `-Step DbCreate` → D1 `family-planner` + R2 `family-planner-drive`, ids recorded.
- [ ] *(me)* Create `wrangler.production.jsonc` with your ids; review together.
- [ ] *(me)* `-Step Deploy` → first deploy on the new origin.
- [ ] *(me)* `-Step Health` → `ok/database/assets` all true.

## Phase 6 — Final export from production
- [ ] **[APPROVAL]** *(you)* approve deploying the snapshot route to the live site.
- [ ] *(me)* Deploy it (single commit, read-only route).
- [ ] *(me)* `-Step Export` as owner → snapshot + sha256.
- [ ] *(me)* Remove the route, deploy the removal, prove `404`.
- [ ] **[APPROVAL]** *(you)* only then continue.

## Phase 7 — Real import
- [ ] *(me)* `-Step Sql`, `-Step Import`.
- [ ] *(me)* `-Step Storage` (no-op if no files) with key preservation.
- [ ] *(me)* `-Step Secret` for `FIELD_KEY` (value never displayed).
- [ ] *(me)* `verify-migration.ps1 -Step All -Credentials` → every check passes.
- [ ] *(me)* Manual: member login, family isolation, personal/office isolation, live SSE update.
- [ ] *(me)* Report counts, hashes, and any orphan files honestly.

## Phase 8 — Android
- [ ] *(me)* `android/gradle.properties` → new URL; allowlist compares `BuildConfig.PLANNER_URL` host.
- [ ] *(me)* Debug APK on the new URL, installed and tested on a phone (or emulator).
- [ ] *(you)* Create a keystore *yourself* with the documented `keytool` command; put the four values in GitHub secrets.
- [ ] *(me)* Tag `v2.1.0` → CI builds, signs, verifies and attaches the APK.
- [ ] *(me)* Confirm the workflow is green and the APK's manifest shows the new URL.

## Phase 9 — Cutover
- [ ] **[APPROVAL]** *(you)* choose the 30–45 minute window.
- [ ] Follow `CUTOVER_PLAN.md` steps 1–9 exactly, in order.
- [ ] *(me)* Final report: what moved, counts, checks that passed, checks that could not run.

## Phase 10 — Rollback retention
- [ ] *(me)* Current deployment still published, untouched.
- [ ] *(you)* after 2+ weeks: decide whether to unpublish it (**separate approval**; unpublishing keeps data and can be reversed).
- [ ] *(me)* Revoke the migration API token.

## Standing rules
- [ ] Never delete the source deployment or its data.
- [ ] Never commit secrets, snapshots or keystores; gitleaks before every commit.
- [ ] No force-push, no history rewrite.
- [ ] Report every check that could not run as NOT RUN, with the reason.
