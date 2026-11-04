# DATABASE_MIGRATION — D1 export and import

Read this once before running anything. It explains **why** each step exists, and the
three ways this kind of migration usually goes wrong.

---

## 0. The shape of the data

13 tables, no foreign keys, no sequences beyond one `AUTOINCREMENT` (`changes.seq`).
Business data lives in `records` as `(space, collection, id, doc JSON, rev, updated_at,
updated_by)` — the ledger is a document store inside one table. `doc` may contain
`enc1:` ciphertext for the sensitive fields listed in `src/fieldcrypto.js`.

Migrated: `meta`, `users`, `credentials`, `records`, `changes`, `notifications`,
`push_subs`, `files`, `ai_connections`, `family_invites`.
Not migrated: `sessions` (origin-bound), `auth_fails`, `rate_limits` (transient abuse
state; copying them could lock you out of your own new site).

The schema is **created at runtime**: `ensureSchema()` in `src/store.js` runs
`CREATE TABLE IF NOT EXISTS` and the guarded `ALTER TABLE` migrations on the first request
that touches the database. This is why:

- there is no `migrations/` directory in the repo;
- you do **not** run `wrangler d1 migrations apply` (it would fail);
- the import contains data only, and it is safe against an empty destination database.

---

## 1. Export (source: the live app)

Because the platform's Cloudflare account is not accessible to us, the dump comes from a
temporary owner-only route in our own Worker. `migrate.ps1 -Step Export` does:

1. prompts for your **email + password** locally (`Read-Host -AsSecureString`) — the
   values are held in memory only, never written to disk, never sent to me;
2. `POST /api/auth/login` on the source URL, keeping the `ffp_session` cookie in memory;
3. `GET /api/admin/snapshot` with that cookie;
4. verifies the JSON parses, that all ten table arrays exist, and that the counts are
   plausible (refuses an empty `users` table — that is the signature of an empty/failed
   dump);
5. writes `migration/out/snapshot-<UTC>.json` plus `.sha256`.

**Treat that file as a secret.** It contains password and PIN hashes, the VAPID private
key, session-independent identifiers, and encrypted personal fields. It is covered by
`.gitignore` (`migration/out/`), and `BACKUP_GUIDE.md` explains where to keep it.

Why the owner session and not a token: it reuses the authorization the app already has,
adds no new credential, and the route can be gated with the same `memberRole()` check
that protects `/api/admin/*` today.

### The route, precisely

```js
if (path === '/api/admin/snapshot' && method === 'GET') {
  if (!session) throw new HttpError(401, 'Sign in first');
  if (await memberRole(env, session.userId) !== 'owner') throw new HttpError(403, 'Owners only');
  // keyset pagination over records/changes/notifications so memory stays flat
  // returns application/json with { exportedAt, schema, counts, tables }
}
```

Implemented in Phase 3 on a branch, unit-tested locally, deployed to **preview** first
(Phase 4). It is read-only and returns 404 once removed.

---

## 2. Convert to SQL

```powershell
node migration/snapshot-tool.mjs counts migration/out/snapshot-<stamp>.json
node migration/snapshot-tool.mjs sql    migration/out/snapshot-<stamp>.json migration/out/sql
```

What the converter guarantees:

- `INSERT OR REPLACE` — re-running an import is idempotent, no duplicate-key crash.
- Every value is escaped (`'` doubled) and bound by type: numbers stay numbers, `null`
  stays `NULL`, objects are JSON-encoded strings.
- Chunks of 400 statements per file (`import-000.sql`, `import-001.sql`, …) because a
  single `wrangler d1 execute` call has request-size limits; `manifest.json` records the
  expected per-table counts.
- No `CREATE TABLE`, no `DROP`, no `DELETE`. The import can add or replace rows; it can
  never delete data that the snapshot does not contain.

---

## 3. Import (destination: your D1)

```powershell
$env:CLOUDFLARE_API_TOKEN = ...        # or use `npx wrangler login` instead
foreach ($f in Get-ChildItem migration/out/sql/import-*.sql | Sort-Object Name) {
  npx wrangler d1 execute family-planner --remote --file $f.FullName
}
```

Expected output per file: `Executed N queries`, with no error. If a statement fails, the
file's remaining statements are not applied — fix the cause, then re-run **all** files
(idempotent), not just the failed one.

Order matters only for `changes.seq` continuity; the converter already emits
`meta → users → credentials → records → …` and preserves explicit `seq` values.

### Then force the schema state

The destination schema is created by the app on first request, and `ensureSchema` compares
`meta.schema` with `SCHEMA_VERSION` (8). The imported `meta` already says `8`, so nothing
re-runs. If you import into a database that already ran `ensureSchema` at an older
version, that is also fine: the guard re-runs only the additive migrations.

### Session handling decision

Sessions are not copied. On the new origin every browser and every phone signs in once
with the **same** PIN or email+password — hashes moved, so nothing is reset. This is
deliberate: copying tokens would leave valid credentials in a JSON file for no benefit,
since the old cookie cannot be sent to the new host anyway.

---

## 4. The three classic failure modes

1. **Empty or truncated snapshot.** Symptom: `snapshot-tool.mjs` refuses with "missing
   table array" or "not valid JSON". Cause: a 401 login, a timeout, or a browser proxy
   truncating the download. Fix: re-run Export; compare the `.sha256`; check the file size
   is in the hundreds of kilobytes, not 0.
2. **Wrong encryption key.** Symptom: `decrypt-check` reports all `BAD`. Cause: the key
   re-applied to the destination is not the one used on 2026-11-03. Fix: stop. Do not
   deploy. Restore the correct key from your password manager. There is no recovery if the
   right key is gone — the ciphertext cannot be brute-forced.
3. **Partial import.** Symptom: count comparison in `verify-migration.ps1` shows fewer
   rows than the manifest. Cause: a chunk failed midway. Fix: re-run every chunk and
   re-verify. Never "fix" this by deleting rows.

---

## 5. Verification (mechanical part)

```powershell
node migration/snapshot-tool.mjs counts migration/out/snapshot-<stamp>.json
npx wrangler d1 execute family-planner --remote --json --command "SELECT 'records' t, count(*) n FROM records UNION ALL SELECT 'users', count(*) FROM users UNION ALL SELECT 'files', count(*) FROM files UNION ALL SELECT 'changes', count(*) FROM changes"
```

Counts must match exactly. `verify-migration.ps1 -Step Counts` automates the comparison,
`-Step Key` runs the decryption check, `-Step Auth` signs in on the destination.
