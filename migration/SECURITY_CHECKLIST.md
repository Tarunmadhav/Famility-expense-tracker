# SECURITY_CHECKLIST

Run this before the first destination deploy and again before cutover. Each line states how
to verify it, not just what to believe.

## Secrets and tokens

- [ ] `FIELD_KEY` is applied to the destination from the file, never typed:
      `Get-Content -Raw .secrets/field_key.txt | npx wrangler secret put FIELD_KEY --config wrangler.production.jsonc`
      Verify: `npx wrangler secret list --config wrangler.production.jsonc` shows the name
      `FIELD_KEY` (names only, values are never readable).
- [ ] `.secrets/` is git-ignored — `git check-ignore -v .secrets/field_key.txt` prints a match.
- [ ] `migration/out/` is git-ignored — same check for a snapshot file.
- [ ] `gitleaks protect --staged` is clean before **every** commit (the CI `security` job
      also scans full history).
- [ ] The Cloudflare API token is scoped to Workers Scripts + D1 + R2 for one account, and
      expires within about a week. Not "All accounts", not "Workers KV/Pages", not global.
- [ ] When finished, revoke the migration token in My Profile → API Tokens.
- [ ] No token, key, password, cookie or snapshot content appears in: the repo, commit
      messages, GitHub Actions logs, this chat, screenshots, or terminal transcripts saved
      to disk.

## The temporary snapshot route (the one new attack surface)

- [ ] Owner-only: `/api/admin/snapshot` returns 403 for a member session and 401 when
      signed out. Both cases are covered by a test in `scripts/smoke.mjs`.
- [ ] Read-only: it performs no writes, no deletes, no schema changes.
- [ ] It is **removed from `src/worker.js`** after the final export, and the removal is
      deployed. Verify on the live URL:
      `curl -s -o NUL -w "%{http_code}" https://<dest>/api/admin/snapshot` → `401`
      with no session is expected only while it exists; after removal, `404`.
- [ ] The removal is a separate commit, so the diff is easy to audit.

## Data handling

- [ ] Snapshots are encrypted at rest wherever they are stored outside this laptop.
- [ ] `migration/out/files-tmp/` is deleted after storage migration (the script does this
      in a `finally` block; confirm the directory is gone).
- [ ] After cutover is proven, stale snapshots are deleted deliberately (they contain
      password hashes).
- [ ] `decrypt-check` has been run and reports a match, so the key in use is correct.

## Destination configuration

- [ ] `compatibility_date` matches the source (`2025-09-01`) so runtime behaviour is
      identical.
- [ ] `observability.enabled = true` so errors are visible in the dashboard.
- [ ] The cookie is `HttpOnly; Secure; SameSite=Lax` on the new origin — unchanged code,
      but confirm with the browser devtools Application → Cookies after login.
- [ ] Rate limiting and lockout tables start empty (`auth_fails`, `rate_limits` not
      migrated) so no phantom lockout blocks the first login.
- [ ] The old deployment remains published until you explicitly say otherwise.

## Known hardening items found during the audit (not fixed by the migration)

- [ ] **`ai_connections.api_key` is stored in plaintext** in D1 (`src/store.js`). Recommended
      follow-up: run it through `encryptField`/`decryptField` like other secrets, and note
      that a plaintext key is visible to anyone with database access.
- [ ] **Settings are global, not per household** (`meta.settings`): a brand-new planner
      inherits the previous household's display label. Cosmetic but worth scoping.
- [ ] PIN login resolves "the first user with a PIN"; with two accounts, document which one
      the PIN belongs to, or move both to email+password.
- [ ] `wrangler.jsonc` still holds a zeroed `database_id` placeholder for local dev — keep
      it that way so a mistaken `wrangler deploy` cannot reach production.

## Post-cutover

- [ ] Rotate the Cloudflare API token or revoke it.
- [ ] Unpublish the old deployment only after 2+ weeks of stable use (explicit approval).
- [ ] Enable Cloudflare's email alerts for Workers errors and D1 usage on the new account.
- [ ] Keep `.secrets/field_key.txt` and the password-manager copy indefinitely.
