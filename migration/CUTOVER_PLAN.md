# CUTOVER_PLAN

Cutover is the only part of this project where being wrong costs data. It is therefore
ordered so that nothing irreversible happens before the thing that proves it works.

You chose "decide later" for the window — that is fine. The procedure below needs a
30–45 minute period when neither you nor the other household member enters data.

---

## Preconditions (all must be true before starting)

- [ ] Destination [`/api/health`] returns `{"ok":true,"database":true,"assets":true}`.
- [ ] A rehearsal import on a **scratch** database produced identical counts.
- [ ] `decrypt-check` reports a match against the rehearsal snapshot.
- [ ] Owner **and** member sign-in both work on the destination with existing credentials.
- [ ] Personal/Office/Family isolation verified (member cannot read the owner's personal book).
- [ ] The APK built against the destination URL has been installed and shows the dashboard.
- [ ] You have explicitly approved the production deployment of the snapshot route.

---

## Step 1 — Announce the freeze (T+0)

Tell the other member not to enter data. Do not delete anything in the old app.

## Step 2 — Take the final snapshot (T+2)

```powershell
.\migration\migrate.ps1 -Step Export
```

New file `migration/out/snapshot-<stamp>.json`. Record its SHA-256 in the report.
**Approval gate:** this requires the snapshot route to be deployed to production.

## Step 3 — Convert and import (T+6)

```powershell
node migration/snapshot-tool.mjs sql migration/out/snapshot-<stamp>.json migration/out/sql-final
.\migration\migrate.ps1 -Step Import -Snapshot migration/out/snapshot-<stamp>.json
```

Because the import is `INSERT OR REPLACE`, rows written after the rehearsal are added and
rows changed are updated. Nothing is deleted.

## Step 4 — Files (T+10)

```powershell
.\migration\migrate.ps1 -Step Storage -Snapshot migration/out/snapshot-<stamp>.json
```

Deletes nothing on the source. If a file is new since the rehearsal, it is uploaded under
its original key.

## Step 5 — Unfreeze writes in the NEW app only (T+15)

From this moment the destination is the app of record. Test on the destination:

1. cash/bank entry on both the **new** site and phone → appears in analytics;
2. add a document → uploads, opens, and its row appears;
3. change a mobile number → reload → still there (proves decrypt/re-encrypt round-trip);
4. second client (phone or second browser) sees the change live.

## Step 6 — Verify (T+25)

```powershell
.\migration\verify-migration.ps1 -Snapshot migration/out/snapshot-<stamp>.json -Base https://<dest> -Deep
```

Every check must pass. A failed check here means: keep the old site as the app of record,
fix, and repeat from Step 2. Do not "accept" a failure because the site looks fine.

## Step 7 — Remove the snapshot route (T+30)

Deploy with the route removed; confirm `/api/admin/snapshot` returns 404 on both the
preview and production destinations. This is not optional: it is the only new endpoint the
migration added.

## Step 8 — Point your devices at the destination

- bookmark / home-screen shortcut → new URL;
- install the freshly built APK (uninstall the debug build first if the signature differs);
- re-enable notifications if the browser treats the new origin as new (subscriptions are
  copied, so this is usually a no-op — verify with `/api/push/test`).

## Step 9 — Keep the old site published (T+45)

Leave it online, unmodified, for at least two weeks. It is the rollback.

---

## Divergence rule

The only unrecoverable scenario is: data written **on the old site** after Step 5. That is
why writes there are frozen. If someone does enter data on the old site afterwards, its
rows are *not* on the new site. Recovery requires a second export and a targeted merge —
costly but possible, since imports are additive and `INSERT OR REPLACE` is idempotent.

Therefore: after Step 5, do not open the old site for data entry. Read history there if you
like; write only on the new one.
