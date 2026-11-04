# CLOUDFLARE_SETUP — preparing your own account

You already confirmed: verified account, Workers/D1/R2 available. This file is what to
click, in order, with the expected result and what to do when it differs. Nothing here
touches your existing live site.

---

## 1. Choose the account and note its name

1. Sign in at https://dash.cloudflare.com
2. If you belong to more than one account, pick the one you want to own this long-term
   (the account switcher is at the top of the sidebar).
3. You do **not** need to know or paste the Account ID for these steps — the CLI records
   it. If a later command needs it, `npx wrangler whoami` prints it; that is not a secret,
   but you do not have to share it with me.

Expected: the dashboard loads with "Workers & Pages" in the sidebar.

---

## 2. Pick the `workers.dev` subdomain

Workers URLs are `<worker-name>.<subdomain>.workers.dev`. The subdomain is chosen **once
per account**.

1. Workers & Pages → the account onboarding page asks you to choose a subdomain if you
   have never deployed a Worker. Choose something you are happy to keep, e.g.
   `tarun-planner`.
2. Expected result on the dashboard: "Your subdomain: `<name>.workers.dev`" is displayed.

If you already have a Worker deployed, your subdomain exists and you cannot easily change
it. That is fine — the app does not care what the subdomain is.

Say "I don't know my subdomain" and I will read it from the CLI after login instead.

---

## 3. Create an API token for the CLI (not for me)

The scripts need a token so `wrangler` can act on your account. Create the narrowest one:

1. Top-right profile icon → **My Profile** → **API Tokens** → **Create Token**.
2. Choose **Create Custom Token** (do not use a template; templates are often too broad).
3. Name it `family-planner-migration`.
4. Permissions — add exactly these three rows, all with **Edit**:
   - `Account` → `Workers Scripts` → Edit
   - `Account` → `D1` → Edit
   - `Account` → `Workers R2 Storage` → Edit
5. Account Resources: **Include** → your account only.
6. Zone Resources: leave as is (no zone is needed; we are not using a domain).
7. TTL: set an expiry about a week out — this token is for the migration, not forever.
8. Create, then **copy the token once**. Store it in your password manager as
   "Cloudflare migration token".

Never paste it into this chat, a screenshot, a file in the repository, or a GitHub
workflow. The scripts read it from an environment variable you set in your own terminal:

```powershell
$env:CLOUDFLARE_API_TOKEN = Read-Host -AsSecureString | ForEach-Object {
  [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($_))
}
```

Expected: no output. `npx wrangler whoami` then lists your account and the token's
permissions. If it says "You are not authenticated", the variable is empty — repeat it in
the same terminal window (environment variables do not persist across windows).

**Simpler alternative:** `npx wrangler login` opens a browser and stores an OAuth token
locally. It is easier for a beginner and does not involve copying a token at all. It
grants broader access than the custom token, but it is stored on your machine only. If
you prefer this, do that instead of the token steps and skip the variable entirely.

---

## 4. Let the scripts create the resources

Do **not** create the database or bucket by hand and then also run the script; pick one
path. The script (`migrate.ps1 -Step DbCreate`) does:

```powershell
npx wrangler d1 create family-planner
npx wrangler r2 bucket create family-planner-drive
```

Expected output includes a `database_id` (a UUID). The script writes it into
`migration/migration.config.json`. These ids are **not** secrets; they are safe to commit.

If `d1 create` fails with "already exists", you created it already — run
`npx wrangler d1 list` and put the existing id in the config file.

If `r2 bucket create` fails with a billing/enable message, open
Storage & Databases → R2 → "Enable R2" in the dashboard, add the billing profile (card is
required by Cloudflare, charges start only beyond the free tier), then re-run the step.

---

## 5. Where the Worker name comes from

`wrangler.production.jsonc` (created in the implementation phase) contains:

```jsonc
"name": "family-finance-planner",
"main": "src/worker.js",
"compatibility_date": "2025-09-01",
"assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": true },
"d1_databases": [{ "binding": "DB", "database_name": "family-planner", "database_id": "<yours>" }],
"r2_buckets": [{ "binding": "FILES", "bucket_name": "family-planner-drive" }],
"observability": { "enabled": true }
```

The first deploy therefore produces
`https://family-finance-planner.<your-subdomain>.workers.dev`. That URL is what the APK
and the scripts will use.

---

## 6. What "success" looks like before moving on

```powershell
npx wrangler d1 list          # family-planner is listed
npx wrangler r2 bucket list   # family-planner-drive is listed
npx wrangler whoami           # right account
```

Then `migrate.ps1 -Step Check` should print all green. Do not proceed to data steps until
it does.
