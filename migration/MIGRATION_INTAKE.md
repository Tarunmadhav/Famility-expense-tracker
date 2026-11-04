# MIGRATION INTAKE — answers from the owner

Rules for this file: one question at a time; every answer recorded verbatim (minus
secrets); "don't know" is a valid answer; no secret values ever written here.

Legend: **ANSWERED** · **OPEN** · **N/A**

| # | Topic | Question | Answer | Status |
| --- | --- | --- | --- | --- |
| 1 | Hosting access | Can you sign in to the Cloudflare account that currently hosts the site (`6e5a40dd…`, Workers namespace `freebuff-sites-prod`) and see its Worker/D1/R2? | "I can sign in to Cloudflare, but I do NOT see any of those resources" → resources belong to the hosting platform's account; **official D1 export / R2 copy is not available to us**. Export must come from inside the app. | ANSWERED |
| 2 | Own Cloudflare account | Do you already have your own Cloudflare account, is it verified, and does it have Workers/D1/R2? | "Yes — verified account with Workers, D1 and R2 available" | ANSWERED |
| 3 | Domain | Do you own a domain you can add to Cloudflare, or should the destination stay on `*.workers.dev` for now? | "I don't own a domain" → destination will be `<worker>.<account-subdomain>.workers.dev`; a domain can be added later without code changes (host kept in one config value). | ANSWERED |
| 4 | FIELD_KEY | Is `.secrets/field_key.txt` backed up outside the laptop? | "Yes — saved in my password manager as well" | ANSWERED |
| 5 | Owner login | Can you still sign in to the live app, and how? | "Both work" (PIN and email+password) → the export can authenticate as owner. | ANSWERED |
| 6 | Stored files | Do you know whether any documents/receipts are currently stored (Drive section non-empty)? | "A few files (1–5)" → **conflicts with the hosting metric (R2 = 0 bytes used)**. Resolve by counting rows in `files` and attempting a download of each from the snapshot; report any orphan immediately. | ANSWERED (needs verification) |
| 7 | Accounts | How many people sign in today (owner only, or members too)? | "Me plus one other person (member)" → 2 identities to verify after import; owner + member roles must survive. | ANSWERED |
| 8 | Cutover window | When may we briefly freeze writes for the final sync? | — | OPEN |
| 9 | Android keystore | Do you already have a release keystore, or will you create one? | "No keystore yet — give me the keytool steps" → no published signature to preserve; new keystore created at the Android phase, never by me. | ANSWERED |
| 10 | Freebuff retention | Confirm the old deployment stays published as rollback until you approve removing it. | — | OPEN |

## Verified locally (no secret values read)

- `.secrets/field_key.txt` exists in the workspace and is git-ignored. It is the file the
  `FIELD_KEY` secret was set from on 2026-11-03. **The value has not been read, printed or
  copied by me**, and it must stay that way: it can be re-applied to the new Worker with
  `wrangler secret put FIELD_KEY < .secrets/field_key.txt`, so neither of us handles it.
  `OPEN`: confirm that this file really is the key used in production (provable by
  decrypting one `enc1:` value from the exported snapshot).
- `backups/local-20261103-2203.json` is a **local development** export, not production data.
- `family-planner-migration-toolkit/` is an earlier documentation-only handoff. It is
  partly inaccurate (e.g. it lists `budgetIn`/`budgetEx` collections that do not exist;
  the code has 8 collections) and it has no verification. Superseded by
  `MIGRATION_AUDIT.md`; left untouched, not part of the migration.

## Notes
- Never write passwords, API tokens, private keys or FIELD_KEY values in this file.
