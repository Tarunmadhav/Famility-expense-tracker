# Roadmap — deferred on purpose

Items the owner explicitly deferred for this version. Nothing here is wired up;
each entry says what is visible today and what it would take.

## 1. Alert-channel routing

**Today:** the "Alert channel" field in Settings → Account is hidden
(`web/src/views.js`, one line marked with a comment). The value is still accepted
and stored by the API (`/api/settings`, `src/worker.js`), so no data is lost.

**Why deferred:** nothing routes alerts by it. Bills, renewals, tasks and
birthdays are raised server-side and delivered by push and Telegram regardless of
the stored value, so exposing the field would promise a choice that does not
exist.

**To finish:** pick a router on the server, honour `settings.channel` for each
alert type, then unhide the field and add a test that a Telegram-only account
receives no web push.

## 2. FCM push and VAPID

**Today:** web push uses a VAPID key pair; the Android shell posts to the tray
through `AndroidBridge.notify`.

**Why deferred:** FCM needs a Firebase project, `google-services.json` in the
Android build, and a server-side service account. That is a separate release with
its own credentials.

## 3. Settings merges beyond the five sections

**Today:** Settings has exactly five sections (Account, Notifications, Backup,
Data, About) and passes its tests. Inside them some cards still overlap:

- Account holds four cards, and "Your profile" repeats the signed-in name and
  email that the top bar and profile switcher already show.
- Two security cards: "Two-factor & recovery" and "Security" (PIN, devices,
  sign-out).
- "Appearance & security" mixes theme, auto-lock and the Books list.
- Two adjacent Backup cards: "Backup" (Google Drive) and "Backup & restore"
  (encrypted file).

**Why deferred:** each merge moves markup between cards rather than deleting it,
so it needs a signed-in session to check by eye at both widths. The five-section
requirement is already met.

## 4. Google sign-in and Telegram end-to-end

**Today:** unit tests cover the OAuth start/return contract, the Telegram webhook
signature check, `/link` code lifecycle and delivery planning. The browser flows
are not exercised.

**Why deferred:** both need external accounts — a Google client with a real
user, and a Telegram chat. `TELEGRAM_WEBHOOK_SECRET` is also still missing in
production, so the live webhook answers 501.

## 5. Orphaned-record cleanup

**Today:** the 77 `records` rows that belonged to the two deleted emulator
accounts are still in production.

**Why deferred:** superseded by the planned clean production database (export,
then wipe). Deleting rows piecemeal first would only add risk.
