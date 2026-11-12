# Cloud backup

Backups go to the user's own Google Drive, into an app-private folder,
as versioned JSON. One provider, deliberately no others: each one needs its own
OAuth app, scopes and review, and an unverified third is a liability rather than a
feature.

## Format

```json
{
  "format": "ffp-backup",
  "schemaVersion": 2,
  "appVersion": "2.6.0",
  "createdAt": "2026-11-09T10:00:00.000Z",
  "moneyUnit": "paise",
  "account": { "id": "…", "email": "…" },
  "profiles": [{ "id": "family", "kind": "family", "name": "Gudipati Family", "role": "owner", "settings": {} }],
  "data": { "family": { "expenses": [{ "id": "EXP-1", "amount": 125050 }] } },
  "counts": { "profiles": 3, "records": 72 },
  "checksum": { "algorithm": "sha256", "value": "…" }
}
```

- **Money is integer paise.** `amount: 125050` is ₹1,250.50. Storage still keeps
  rupees as JSON numbers; the export converts, the restore converts back, and
  `moneyUnit` is declared so a future reader does not have to guess. Changing the
  storage itself is a separate migration.
- **The checksum covers everything except `checksum` itself**, over canonical JSON
  (keys sorted), so the same data always hashes the same way. A restore refuses a
  file whose checksum does not match.
- A backup contains every profile the account can open, not just the one on
  screen, and each chapter keeps its own settings.

## Restore

`POST /api/cloud/restore` with `{ provider, fileId }` (from the drive) or
`{ payload }` (a file the browser already has).

1. Validate format, `schemaVersion` (refuse a newer one), `moneyUnit`, checksum.
2. Refuse any profile the account is not a member of — a backup is not a way into
   somebody else's book.
3. Merge by id inside **one D1 batch**, which is one transaction: matching rows
   are replaced and their `rev` advances, new rows are added, nothing is deleted.
4. Cap at 900 records per restore (one batch); a larger file is refused with a
   message rather than half-applied.

The UI asks for confirmation first and spells out that merge semantics are not a
wipe.

## Connection and secrets

| Secret | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` (var), `GOOGLE_CLIENT_SECRET` (secret) | Google sign-in and Drive (`drive.appdata`) |
| `BACKUP_KEY` | 32 bytes, base64url — AES-256-GCM key for the stored refresh tokens |

Generate the key with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` and set
it with `npx wrangler secret put BACKUP_KEY`. Without it the provider endpoints
answer 501 and the UI says so: a refresh token is never written in clear text, so
there is nothing to fall back to.

Refresh tokens are sealed as `v1.<iv>.<ciphertext>` with AES-256-GCM and the
additional data `ffp-cloud-refresh-token`. A token sealed with a different key
fails to open and the connection is reported as needing a reconnect — it is never
silently used.

The scope is the narrowest that still allows a file: Google's `drive.appdata` is a
folder the user cannot browse. A stolen token cannot read the rest of the drive.
Google is the only cloud provider; the `onedrive` value remains in the
`cloud_links` CHECK constraint because removing it would mean rebuilding the table,
and no row uses it.

## Automatic backup

Off by default, per account: `backup_settings.enabled = 0` until the owner turns it
on in Settings → Backup, after connecting a drive.

- A Cron Trigger (`wrangler.jsonc`, daily at 02:17 UTC) calls
  `runScheduledBackups`. Only accounts with `enabled = 1` and a live connection are
  considered, and each is due at most once a day (`frequency = 'daily'`) or once a
  week (`'weekly'`).
- Each run exports, uploads, records a row in `backup_runs`, updates
  `last_run_at`, then deletes files beyond `keep` (default 7, max 60).
- One failing account (expired token, provider outage) is logged and skipped; the
  attempt still updates `last_run_at` so a broken connection does not retry every
  minute.

Manual "Back up now" uses the same path with `trigger = 'manual'`.

## Testing without credentials

`npm test` covers the format, the checksum, paise round-tripping, restore
atomicity, refusal of a damaged or foreign file, token sealing, and the scheduled
run (including pruning) with a mocked provider. The provider calls themselves need
real credentials: until they exist the UI shows each provider as not configured,
which is the honest state, not a placeholder.
