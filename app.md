# Family Finance Planner — start here

A private money planner for one household. It runs three separate books — **Family**,
**Personal** and **Office** — with a server-enforced lock, end-to-end encrypted sensitive
fields, and an Android app that wraps the same site.

Nothing here is a demo: the site is live and the database is real. Read this file top to
bottom before running a command.

---

## 1. What you are looking at

| Piece | Where it lives | What it does |
| --- | --- | --- |
| Web app | `web/` | The screens, styles and browser code |
| Server | `src/worker.js`, `src/store.js` | Cloudflare Worker: API, auth, sessions, books |
| Database | Cloudflare **D1** (binding `DB`) | Accounts, records, notifications, change log |
| File storage | Cloudflare **R2** (binding `FILES`) | Bills, policies and documents you upload |
| Field encryption | secret `FIELD_KEY` | AES-256-GCM for account numbers, policy numbers, etc. |
| Android app | `android/` | Thin WebView shell + native notifications |
| Deploy config | `wrangler.jsonc` | Worker + D1 + assets for your Cloudflare account (`deploy.json` is the legacy Sites manifest) |

**Live site:** https://family-finance-planner.tarungudipatimadhav.workers.dev
**Preview site:** same Worker (there is no separate preview environment on a plain account)
**Android package:** `com.family.planner` — versionName `2.0`, versionCode `1`

The Android app does not contain the website. It opens the live URL in a WebView, so
whatever is deployed is what the phone shows.

---

## 2. What you need installed

| Tool | Version used here | Check it |
| --- | --- | --- |
| Node.js | 22 (CI uses 22) | `node -v` |
| npm | comes with Node | `npm -v` |
| Git | any recent | `git --version` |
| JDK | 17 | `java -version` |
| Android SDK | platform 36, build-tools 36.0.0 | see section 6 |

You do **not** need Docker, Postgres, or a Cloudflare login to run the app locally.

---

## 3. Start the app on your computer (5 minutes)

Open a terminal in the project folder and run these three commands, in this order.

```bash
# 1. Install the JavaScript dependencies exactly as the lockfile pins them
npm ci

# 2. Build the web bundle and the Worker
npm run build

# 3. Start the local server (leave this terminal open)
npm run dev:api
```

`npm run dev:api` starts a local Cloudflare Worker on **http://127.0.0.1:8787** using a
local copy of D1 and R2. Wait for a line that mentions `Ready on http://127.0.0.1:8787`,
then open that address in your browser.

Check it is alive at any time:

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"database":true,"assets":true,"time":...}
```

### First login

- The **first account you create on an empty database becomes the owner**.
- **Signing up needs no invite.** Leave the invite code blank and the account becomes
  the owner of a brand-new, private planner — your own Family, Personal and Office books.
- To share someone else's family book, enter the **invite code** their owner creates in
  *Settings → Members → Create invite*. The code is optional; a wrong or expired code is
  rejected with `400` rather than silently ignored.
- The app is PIN-locked. Set a PIN you will remember; forgetting it does not lose data,
  but you must sign in again to reset it.

### Hot-reload for UI work

If you are changing `web/` files and want instant reload, use a second terminal:

```bash
npm run dev        # Vite dev server
```

`npm run dev:api` serves the built files; `npm run dev` serves them live from source.

### Run the full test suite

```bash
# the server must already be running on port 8787
FFP_PIN=<your PIN> npm run smoke
```

You should see `All smoke checks passed.` (72 checks). The suite covers signup gating,
the three books, invite codes, member removal, server-side lock revocation, the office
collection whitelist and the per-user write limit.

---

## 4. The three books (important)

| Book | Who sees it | Header |
| --- | --- | --- |
| Family | everyone in the household | `X-Space: family` |
| Personal | only you (`u:<your id>`) | `X-Space: personal` |
| Office | only you (`o:<your id>`), work modules only | `X-Space: office` |

Each account belongs to exactly one **household**, and the shared family book is scoped to
it: two people who sign up without invites get separate planners and never see each
other's rows. The account that creates a household owns it and is the only one who can
invite or remove its members.

The server decides the real book and household from your session; the header only selects
which book inside it.
Office accepts **diary, contacts, expenses** and rejects anything else with `400`.
Every write is limited to **120 changes per minute per account**; past that you get `429`.

---

## 5. Deploy the website

Deployment goes through **Cloudflare Sites**, not `wrangler deploy`.

```bash
npm run build          # produces dist/, build/ and deploy.json
```

Then publish `deploy.json` with the Sites deploy step you normally use. Secrets
(`FIELD_KEY`) are set once in Sites → production/preview → Secrets; they are never in
this repository.

Before deploying, confirm:

```bash
npm run build
npm audit --audit-level=high     # must print "found 0 vulnerabilities"
```

CI (`.github/workflows/ci.yml`) already runs install → audit → build → the 72-check
suite on every push to `main`.

> **Never lose `FIELD_KEY`.** It decrypts stored account and policy numbers. It is not in
> git and cannot be recovered from the database. Keep an offline copy in your password
> manager.

---

## 6. Build the Android APK

### One-time setup

```bash
# JDK 17 must be the java on PATH
java -version
```

Point Gradle at your SDK by creating `android/local.properties` (already gitignored):

```properties
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

If `platforms/android-36` or `build-tools/36.0.0` is missing, install them once:

```bash
sdkmanager --install "platforms;android-36" "build-tools;36.0.0"
```

### Build a test APK (no signing secrets needed)

```bash
cd android
./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk` (about 12 KB).
This is signed with the throwaway **debug** key, so it installs on a phone but is not
store-publishable and cannot be replaced later by a release build without uninstalling.

### Build the real, signed release APK

You need your own keystore first. Create it yourself — never commit it:

```bash
keytool -genkeypair -v -keystore ~/family-planner-release.jks \
  -alias family-planner -keyalg RSA -keysize 4096 -validity 10000 -storetype JKS
```

Then export the four variables and build:

```bash
export ANDROID_KEYSTORE_PATH="$HOME/family-planner-release.jks"
export ANDROID_KEYSTORE_PASSWORD='your keystore password'
export ANDROID_KEY_ALIAS='family-planner'
export ANDROID_KEY_PASSWORD='your key password'
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.

If any variable is missing, the build **stops** with
`Release signing is not configured. Missing environment variables: …` — it never falls
back to the debug key. Full details: `android/SIGNING.md`.

### What the CI produces

`.github/workflows/android-apk.yml` runs on every push to `main` and on pull requests:

1. **test** — npm ci, build, 72-check suite.
2. **security** — `npm audit --audit-level=high` and gitleaks over full history.
3. **build-debug** — sideloadable debug APK, artifact `family-planner-apk-debug` (14 days).
4. **signing-ready → build-apk** — signed release APK. This pair is **skipped** until the
   four repository secrets exist, so pushes stay green while you set them up.
5. **upload** — artifact `family-planner-apk` with a SHA-256 in the job summary.
6. **release** — only when a `v*` tag is pushed, attaches the APK to a GitHub Release.

Repository secrets to add yourself (Settings → Secrets and variables → Actions):

`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`.

---

## 7. Install the APK on a phone (newbie steps)

**Option A — USB cable**

1. On the phone: Settings → About phone → tap *Build number* seven times to unlock
   Developer options.
2. Settings → Developer options → enable **USB debugging**.
3. Connect the cable, tap **Allow** on the phone prompt.
4. On the computer:

```bash
adb devices                 # your phone must be listed
adb install -r family-planner-2.0-debug.apk
```

**Option B — copy the file**

1. Send the `.apk` to the phone (email, cloud drive, USB storage).
2. Tap it in the Files app.
3. Android asks to allow installs from that app — allow it once.
4. Tap **Install**, then **Open**.

The app opens the live planner. Sign in with the account you created. Bills, insurance
renewals and tasks can appear as Android notifications; allow the notification permission
on first launch.

**Updating later:** install a newer APK with the same signing key over the old one. If
the keys differ, Android refuses — uninstall the old app first, which erases its local
session but not your data (data lives on the server).

**Uninstalling:** long-press the icon → Uninstall. Your records stay in the database.

---

## 8. Where the data and secrets live

| Thing | Location | In git? |
| --- | --- | --- |
| `FIELD_KEY` | Cloudflare Sites secret | never |
| D1 database | Cloudflare, binding `DB` | no (schema is in `src/store.js`) |
| R2 bucket | Cloudflare, binding `FILES` | no |
| Android keystore | your machine + GitHub secret | never (`*.jks` ignored) |
| Local dev data | `.wrangler/state` | ignored |
| Backups | `backups/` | ignored |
| Scanners/benchmarks | `tools/`, `artifacts/` | ignored |

Schema version is **7** and is applied automatically by `ensureSchema()` on the first
request after a deploy. There is no `migrations/` folder to run by hand.

---

## 9. Useful commands

```bash
npm ci                     # clean install from the lockfile
npm run build              # web + worker bundle + deploy.json
npm run dev:api            # local Worker on :8787
npm run dev                # Vite hot reload
FFP_PIN=... npm run smoke  # 72-check end-to-end suite
npm audit --audit-level=high

cd android
./gradlew assembleDebug    # test APK
./gradlew assembleRelease  # signed APK (needs the four env vars)
./gradlew clean            # wipe build outputs

git status                 # what changed
git log --oneline -5       # recent history
```

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm ci` fails with `EPERM ... workerd.exe` | the local Worker is still running | stop `npm run dev:api`, run `npm ci` again |
| `worker did not start` in CI | port 8787 busy or build stale | rerun `npm run build`, check nothing else uses 8787 |
| `400 That invite code is not valid or has expired` | wrong, used or expired code | leave the code blank to start your own planner, or ask the owner for a fresh one |
| Signed up without a code and see no data | that is expected | you own a new empty planner; use an invite code to join an existing household |
| `429 Too many changes in a minute` | write limit (120/min) | wait a minute |
| `Release signing is not configured` | env vars missing | export the four variables, see section 6 |
| Gradle: `SDK location not found` | no `local.properties` | add `sdk.dir=…` as in section 6 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | different signing key | uninstall the old app, install again |
| Site shows old build | deploy not run after `npm run build` | rebuild and publish `deploy.json` |
| `sdkmanager: command not found` | SDK tools not on PATH | use the full path under `$ANDROID_HOME/cmdline-tools/*/bin` |

---

## 11. Before you call it "launched"

- [ ] `npm run build` succeeds and `npm audit --audit-level=high` prints 0 vulnerabilities.
- [ ] `FFP_PIN=... npm run smoke` prints `All smoke checks passed.`
- [ ] The live URL returns `200` and `/api/health` reports `ok: true`.
- [ ] The site sends `Content-Security-Policy`, `X-Content-Type-Options`,
      `Referrer-Policy` and `Strict-Transport-Security`.
- [ ] You have an **offline copy of `FIELD_KEY`** — without it, encrypted fields are gone.
- [ ] The Android APK installs and opens the live site.
- [ ] The four signing secrets exist, and `build-apk` is green rather than skipped.
- [ ] Only you can read the Office book; another account sees an empty one.
