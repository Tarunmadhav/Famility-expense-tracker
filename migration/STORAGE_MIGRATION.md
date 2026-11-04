# STORAGE_MIGRATION — uploaded files (R2)

You reported "a few files (1–5)". The hosting dashboard simultaneously reports
**0 bytes stored** in R2. Those two cannot both be true, so the first job is to find out
which is real, from the data rather than from either dashboard.

---

## 1. Count first

The `files` table is authoritative about what the app *thinks* exists:

```powershell
node migration/snapshot-tool.mjs list-files migration/out/snapshot-<stamp>.json
```

Possible outcomes:

| Outcome | Meaning | Action |
| --- | --- | --- |
| `[]` (empty array) | no file rows — the Drive is empty, or everything was deleted | storage migration is a no-op; skip this file |
| rows with sizes | files exist in metadata | continue below; verify each object actually downloads |
| rows, but a download returns 404 | **orphan metadata**: the row survived, the object is gone | record it in the report; the app already shows "File contents are gone". Copy nothing for that row; it is pre-existing breakage, not caused by the migration |

Never delete orphan rows as part of the migration. They are evidence and they may point at
a still-recoverable object.

---

## 2. Why keys must be preserved

Uploads are stored as `drive/<uuid>.<ext>` (`src/worker.js`, key built server-side per
upload) and the `files` row stores that key. The app reads `files.key` to fetch an object.
Therefore:

- copying objects **with their original keys** means the imported `files` rows work with
  no code change at all;
- re-uploading through `/api/files` would mint **new UUIDs**, new rows, and leave the
  imported rows pointing at nothing.

So the copy must be: download bytes from the source, then `wrangler r2 object put` with the
exact original key.

---

## 3. Copy procedure

```powershell
# 1. authenticate to the source app (prompted, never stored)
# 2. for each row from list-files:
#      GET /api/files/<id>   -> bytes (needs the owner cookie)
#      npx wrangler r2 object put "family-planner-drive/drive/<uuid>.<ext>" --file <tmp> --content-type <mime>
#      compare sha256(source bytes) with sha256(downloaded again from the destination)
```

`migrate.ps1 -Step Storage` implements exactly this and refuses to continue on any of:

- a size mismatch between the source bytes and the `files.size` column (uploads are
  limited to 8 MB and content-sniffed, so a mismatch means corruption or a wrong object);
- a non-2xx download;
- an R2 upload that returns non-zero exit code.

Enhanced verification (optional, stronger): after the whole copy, add an `r2 object get`
round-trip for each key and compare hashes against the source. `verify-migration.ps1
-Step Files` does this if you pass `-Deep`.

Why not S3-compatible bulk copy from source to destination: the source bucket belongs to
the platform's account and no S3 credentials for it exist. There is nothing to copy
*between* accounts without that access.

---

## 4. Where the bytes live during the copy

Temporary directory `migration/out/files-tmp/`, one file at a time, deleted after each
successful upload, and the directory removed at the end. Files are receipts and documents —
they are private. Do not leave that directory behind on a shared machine; the script
removes it in a `finally` block even when a step fails.

`.gitignore` covers `migration/out/`, so a stray file cannot be committed. `gitleaks` and
the CI diff check are still run before any commit.

---

## 5. Success criteria

- number of R2 objects in the destination = number of non-orphan `files` rows;
- every object's SHA-256 equals the source object's;
- opening one document in the new deployment serves the same bytes (`Content-Length`
  matches `files.size`);
- `files` count in the destination D1 equals the source count.

`/api/files` returning 200 is not proof; byte equality is.
