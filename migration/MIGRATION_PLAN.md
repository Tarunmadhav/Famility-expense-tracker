# MIGRATION PLAN — Family Finance Planner → your own Cloudflare account

Nothing in this plan has been executed. Every production-changing step needs your
explicit approval, and each one is listed in `MIGRATION_CHECKLIST.md` as a separate gate.

---

## 1. Goal and non-goals

**Goal:** the same application, the same data, the same accounts, running from a
Cloudflare account you own and can log into, reachable at a `*.workers.dev` address,
with an Android APK built against the new address.

**Non-goals (deliberately excluded):** no rewrite, no framework migration, no schema
redesign, no new auth provider, no feature removal, no deletion of the current deployment.

---

## 2. Target architecture (mapping)

| Concern | Today | Destination |
| --- | --- | --- |
| Compute | Worker `site-0f6d51dc…` in the platform's account/namespace | Worker you create (name `family-finance-planner`) in **your** account |
| Static site | `build/static` uploaded as Worker assets by the platform | same files via `assets.directory` in `wrangler.production.jsonc` |
| Database | D1 `site-8bcdb5c7…` (platform-named) | D1 `family-planner` in your account, same 13 tables, same rows |
| Files | R2 `site-addf0669…` | R2 `family-planner-drive`, **identical object keys** |
| Encryption | secret `FIELD_KEY` | same secret, re-applied from `.secrets/field_key.txt` (never displayed) |
| VAPID (push) | row in D1 `meta` | copied with the database — existing browser subscriptions keep working |
| AI connector | rows in D1 `ai_connections` | copied with the database |
| Auth | PBKDF2 hashes in `users` + `credentials` | copied verbatim; nobody is re-invited or reset |
| URL | platform `freebuff.page` subdomain | `<worker>.<your-subdomain>.workers.dev` |
| Android | loads the platform URL | rebuilt APK loading the new URL |

Why this is a pure re-host: the app is one module Worker using only WebCrypto, `fetch`,
D1 and R2 — no `nodejs_compat`, no adapters, no server process. Fidelity risk is therefore
concentrated in **data**, not in runtime behaviour.

---

## 3. The export problem, and the decision

Cloudflare's supported export (`wrangler d1 export --remote`, used by
`ops/backup-d1.sh`) requires API credentials **for the account that owns the database**.
That account is the hosting platform's, and you confirmed you cannot see its resources.
So:

- ❌ `wrangler d1 export --remote` against the current database — not available to us.
- ❌ Cloudflare dashboard D1 "Export" button — same account problem.
- ❌ The app's `/api/export` — **insufficient**: it returns only the 8 business
  collections plus `settings`. It omits `users`, `credentials`, `records`' siblings,
  `files`, `push_subs`, `notifications`, `ai_connections`, `family_invites`, `meta`
  (which holds the VAPID keypair). Using it would migrate the ledger and lose every
  login.
- ✅ **Owner-authenticated snapshot route inside the Worker we already deploy.** We own
  that code, so we can add a read-only route that dumps all migratable tables, call it
  once as the owner, and then remove it.

This is the only path that preserves accounts, hashes, push subscriptions and file
references together. It is a code change, so it is a gated step you approve before it is
deployed, and it is removed immediately afterwards.

### Route specification (to be implemented in Phase 3, reviewed before deploy)

```
GET /api/admin/snapshot
  auth: owner session only (existing getSession + role check); 403 otherwise
  returns application/json attachment:
  {
    "exportedAt": "2026-11-04T…Z",
    "schema": "8",
    "counts": { "users": 2, "records": 137, … },
    "tables": {
      "meta": [ { k, v } ],                  // includes 'schema' and 'vapid' (private!)
      "users": [ … ], "credentials": [ … ],
      "records": [ { space, collection, id, doc, rev, updated_at, updated_by } ],
      "changes": [ … ], "notifications": [ … ], "push_subs": [ … ],
      "files": [ … ], "ai_connections": [ … ], "family_invites": [ … ]
    }
  }
  deliberately excluded: sessions, auth_fails, rate_limits
  streaming/batched: keyset pagination over records so a large ledger cannot hit a
  Worker memory limit; the client receives one JSON object either way.
```

Not migrated, on purpose:

| Table | Why |
| --- | --- |
| `sessions` | tokens are bound to the old origin's cookie; a new host cannot use them. Owner + member sign in again with the same PIN/password. |
| `auth_fails`, `rate_limits` | transient abuse counters; copying lockouts would lock you out of your own new site. |

---

## 4. Phases (each ends at an approval gate)

| Phase | What happens | Production impact | Gate |
| --- | --- | --- | --- |
| 1 | Audit (done) | none | — |
| 2 | Interview (done) | none | — |
| 3 | Add the snapshot route + its tests on a branch; rehearse locally against a seeded database | none until deployed | you review the diff |
| 4 | Deploy the route to the **preview** environment, take a snapshot there, prove it round-trips | preview only | approval |
| 5 | Create destination D1 + R2 + Worker in your account; import that snapshot; run the verification suite | none (new origin) | approval |
| 6 | Deploy the snapshot route to **production** only long enough to take the final snapshot; remove it in the same session | brief, read-only route | **explicit approval** |
| 7 | Import final snapshot, copy files with preserved keys, set `FIELD_KEY`, verify counts + hashes + logins + isolation | none (new origin) | approval |
| 8 | Rebuild the APK against the new address after changing the in-app link allowlist | none | approval |
| 9 | Cutover: point your bookmarks/APK at the new URL; write freeze for the final sync | writes paused 30–45 min at a time you choose | **explicit approval** |
| 10 | Keep the current deployment published untouched as rollback | none | — |

Rehearsal is the point of Phases 4–5: the same scripts, the same import, on a copy,
before the real thing.

---

## 5. Repository changes this migration will make (all reviewable)

1. `src/worker.js` — add `GET /api/admin/snapshot` (owner-only, read-only), plus two
   checks in `scripts/smoke.mjs`. **Removed after the final export.**
2. `wrangler.production.jsonc` — new file: your `database_id`, your bucket name, the same
   `compatibility_date`, `assets.run_worker_first`, observability. `wrangler.jsonc` stays
   as the local-dev config with its placeholder id; `deploy.json` stays untouched so the
   current host keeps working.
3. `android/gradle.properties` — `plannerApiBaseUrl` → new URL.
4. `android/app/src/main/java/com/family/planner/MainActivity.java` — replace the
   hardcoded `host.endsWith("freebuff.page")` allowlist with a comparison against the
   host of `BuildConfig.PLANNER_URL`, so the APK follows its own configuration instead of
   a domain baked into code.
5. `.github/workflows/` — add an optional deploy job for your account, triggered by
   `workflow_dispatch` only (never automatically). Reuses a repository secret
   `CLOUDFLARE_API_TOKEN` scoped to Workers + D1 + R2 for one account.
6. `migration/*` — this toolkit.

No change touches the schema, the collections, the auth algorithm or the UI.

---

## 6. Verification (what "done" means)

Per-table row counts equal; every migrated file's byte size and SHA-256 equal; every
`enc1:` value decrypts with the migrated `FIELD_KEY`; owner **and** member can sign in on
the new origin with their existing credentials; a member cannot read another household's
book; Personal and Office books stay isolated per user; create/update/delete round-trips;
SSE delivers a change to a second client; push subscription still resolves to a VAPID key;
`/api/health` reports `database:true, assets:true`. `/api/health` returning 200 alone is
explicitly **not** accepted as proof.

`verify-migration.ps1` automates the mechanical half.

---

## 7. Rollback stance

The current deployment is never modified and never unpublished during this work, so
rollback is "keep using the old URL". Data written on the new site after cutover is the
only thing that cannot be rolled back automatically — the cutover window exists to make
that window small, and `ROLLBACK_PLAN.md` covers the divergence case.

---

## 8. Cost

Workers free plan, D1 free tier (5 M reads/day, 100 k writes/day) and R2 free tier
(10 GB) all exceed this household's usage (measured today: ~5 000 requests/month, 456 KB
database, 1 922 writes/month). R2 requires a billing profile to enable; typical cost at
this volume is 0. A domain is optional and not required.
