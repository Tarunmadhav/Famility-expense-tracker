# BACKUP_GUIDE — what to save, where, and how to prove it works

A backup you have never restored is a hope, not a backup. This file defines the two
artefacts, where they go, and the restore test that proves them.

---

## 1. Artefact 1 — the database snapshot

| Property | Value |
| --- | --- |
| Produced by | `migrate.ps1 -Step Export` (owner-authenticated `GET /api/admin/snapshot`) |
| Path | `migration/out/snapshot-<UTCstamp>.json` + `.sha256` |
| Size | ~0.5–2 MB for this household |
| Contains | every row of 10 tables, including **PBKDF2 password/PIN hashes**, the **VAPID private key** (`meta.vapid`), `enc1:` ciphertext of phones/emails/notes, and AI connector keys in plaintext (today) |
| Sensitivity | **highest** — treat like a password database |

Rules:

1. It must never be committed. `migration/out/` is git-ignored; verify with
   `git status --ignored | Select-String out`.
2. Keep at most three copies, all outside the repository: the project folder, an encrypted
   archive in your password manager / cloud drive, and one offline.
3. If you email it or upload it anywhere, encrypt first (7-Zip AES-256 with a password from
   your password manager is enough for this threat model).
4. Delete stale snapshots deliberately once the migration is proven — each is a full copy
   of your family's financial history.

Verify integrity immediately after export:

```powershell
Get-FileHash migration/out/snapshot-*.json -Algorithm SHA256
Get-Content   migration/out/snapshot-*.json.sha256
```

The two hashes must match.

---

## 2. Artefact 2 — the encryption key

`FIELD_KEY` lives in `.secrets/field_key.txt` (git-ignored) and, per your answer, in your
password manager. That is the minimum: two independent copies.

- Do not rotate it during the migration.
- Do not regenerate it. A new key cannot decrypt old ciphertext.
- Do not print it into a terminal that logs to a file, a chat, a screenshot or a ticket.
- The scripts move it with stdin redirect (`wrangler secret put FIELD_KEY` reading the
  file), so the value never appears in a command line, shell history or process list.

---

## 3. Artefact 3 — code and configuration

Already covered by git: `main` is the source of truth and CI is green. Tag the migration
point so the exact tree is recoverable:

```powershell
git tag -a migration-start -m "State before the Cloudflare account migration" b3c2f36
git push origin migration-start
```

Record in the migration report: the commit SHA, the `wrangler.production.jsonc` contents
(no secrets in it), the D1 id and the bucket name.

---

## 4. Restore test (do this before cutover, on a scratch database)

Proves both the snapshot and the key are usable:

```powershell
# 1. import the snapshot into a throwaway local D1
npx wrangler d1 create family-planner-restore-test
# put its id in a scratch config, then:
Get-ChildItem migration/out/sql/import-*.sql | Sort-Object Name | ForEach-Object {
  npx wrangler d1 execute family-planner-restore-test --remote --file $_.FullName
}
# 2. compare counts
node migration/snapshot-tool.mjs counts migration/out/snapshot-<stamp>.json
# 3. prove the key
node migration/snapshot-tool.mjs decrypt-check migration/out/snapshot-<stamp>.json .secrets/field_key.txt
# 4. when satisfied, delete the scratch database from the dashboard (explicit approval)
```

Expected: identical counts, and `decrypt-check` printing `RESULT: this key matches the
production data. Keep it.`

If step 3 fails, **stop the migration**. Every hour spent before cutover is cheap; every
hour spent after is not.

---

## 5. What NOT to use as a backup

- `/api/export` (the app's own JSON export): business collections only — no accounts, no
  password hashes, no push subscriptions, no file keys. Fine as a human-readable ledger
  copy, useless as a restore source.
- `backups/local-*.json` in this repo: a local development database, unrelated to
  production.
- A screenshot of the dashboard: not data.
