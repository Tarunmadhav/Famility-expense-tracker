# ROLLBACK_PLAN

The migration is designed so that rollback is almost always "stop, and keep using the old
site". This file states exactly what to do for each failure point, and what cannot be undone.

---

## Before cutover (Phases 3–8)

Nothing has moved. Rollback = do not proceed.

- The old deployment is unmodified and still serving.
- The temporary snapshot route can be removed by deploying the previous commit; the live
  app returns to its exact prior behaviour.
- Destination resources (D1/R2/Worker) can be deleted if abandoned — **only with your
  explicit approval**, and only after confirming they contain nothing you need.

## During cutover, before Step 5 (writes unfrozen on the new site)

The new site has data copied but is not yet the app of record.

1. Stop the procedure.
2. Keep the old site as the app of record; tell the household to continue using it.
3. Delete the destination D1 rows if a clean re-import is wanted (approved action), or just
   re-import — the import is idempotent.
4. Fix the cause, then restart from Step 2 with a fresh snapshot.

No data has been written to the new site yet, so nothing is lost.

## After Step 5 (new site is the app of record)

This is the risky zone. Two sub-cases:

### A. New site is broken, but no new data has been entered there

Roll back instantly: point devices back at the old URL. The old site still holds the
complete dataset up to the final snapshot. Nothing to restore.

### B. New site is broken AND data was entered there

The new rows exist only in the destination database. Procedure:

1. Do **not** delete the destination database. It is the only copy of those rows.
2. Export the destination:
   ```powershell
   npx wrangler d1 export family-planner --remote --output migration/out/dest-after-cutover.sql
   ```
   (This works now, because the destination is in your account — the very capability we
   did not have on the source.)
3. Choose one:
   - **Repair forward** (preferred): fix the destination, keep it as the app of record.
   - **Merge back**: re-point devices at the old site and re-enter the small number of
     affected records manually (realistically minutes of work for one household).
     Automated reverse-merge is possible — `records` are keyed by `(space, collection, id)`
     so rows can be replayed — but it is a bespoke operation, not a script in this toolkit.
4. Record what happened in the migration report.

## If the destination Worker is misconfigured (rollback of a single deploy)

```powershell
npx wrangler deployments list --config wrangler.production.jsonc
npx wrangler rollback <deployment-id> --config wrangler.production.jsonc
```

Rolling back a Worker deployment does not touch D1 or R2 — data is unaffected.

## If the encryption key turns out to be wrong (detected by `decrypt-check`)

Do not cut over. The ciphertext on the new site would be unreadable. Restore the correct
key from your password manager, re-apply the secret, and re-verify. If the correct key is
genuinely lost, encrypted fields cannot be recovered from either copy — this is why the key
check runs before any production step.

## If the old deployment is accidentally unpublished

Re-publish it from the hosting panel (the deployment and its data are retained; unpublishing
does not delete data). This is reversible and is exactly why the migration never deletes
the old project.

## What is genuinely irreversible

| Action | Reversible? |
| --- | --- |
| Destination deploy / rollback | yes |
| Import rows | yes (idempotent, additive) |
| Delete destination D1/R2 | **no** |
| Regenerate FIELD_KEY | **no** — old ciphertext becomes unreadable |
| Delete the old project | **no** |
| Data written on the old site after cutover (missing from the new one) | recoverable only by manual re-entry or a bespoke merge |

Nothing in the "no" column is performed by any script in this toolkit without a separate,
explicit confirmation.
