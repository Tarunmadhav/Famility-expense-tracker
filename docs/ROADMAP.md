# Roadmap — deferred on purpose

Items the owner explicitly deferred for this version. Nothing here is wired up;
each entry says what is visible today and what it would take.

## 1. Alert-channel routing

**Today:** the "Alert channel" field is gone from Settings → Account — it was a
control with no effect, so it was removed rather than hidden. The value is still
accepted and stored by the API (`/api/settings`, `src/worker.js`), so a stored
choice is not lost.

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
Data, About) and passes its tests. **The two security cards are now one** (PIN,
other devices and sign-out, then the security audit beneath them), and **the two
Backup cards are now one** (Google Drive, automatic backup, then the encrypted
file restore). Both merges delete a card wrapper, not content.

What still overlaps:

- Account holds several cards, and "Your profile" repeats the signed-in name and
  email that the top bar and profile switcher already show.
- "Appearance & security" mixes theme, auto-lock and the Books list.

**Why deferred:** each remaining merge moves markup rather than deleting it, so it
wants a signed-in session to check by eye at both widths. The five-section
requirement is already met.

## 4. Google sign-in and Telegram end-to-end

**Today:** unit tests cover the OAuth start/return contract, the Telegram webhook
signature check, the `/link` code lifecycle, every bot command and delivery
planning. Both secrets are set in production.

Fixed in 2.6.0: the Drive callback no longer answers `403 Cross-origin request
blocked` — the provider's GET return is exempt from the origin check while POST,
PUT, PATCH and DELETE keep it.

**Why still open:** both need external accounts — a Google client with the
callback URL registered, and a Telegram chat. The webhook has to be registered
with the real token, which the owner keeps out of chat.

## 5. Orphaned-record cleanup

**Today:** the 77 `records` rows that belonged to the two deleted emulator
accounts are still in production.

**Why deferred:** superseded by the planned clean production database (export,
then wipe). Deleting rows piecemeal first would only add risk.
