# Google Calendar sync

Tasks that have a **due time** are mirrored into a Google Calendar that this app
creates and owns. All-day tasks stay out of it: they have no moment to put on a
timeline.

## What the app asks for

`https://www.googleapis.com/auth/calendar.app.created` — Google documents it as
*"Make secondary Google calendars, and see, create, change, and delete events on
them."* The token therefore cannot read or change any other calendar in the
account, including the person's own primary calendar.

## Setup (owner, once)

1. Google Cloud Console → the same project as `GOOGLE_CLIENT_ID`:
   - enable **Google Calendar API**;
   - add the scope above under **OAuth consent screen → Data access**;
   - add `https://<worker-host>/api/calendar/callback/google` as an authorised
     **redirect URI** on the web client, and keep the owner's address in
     **Test users** while the app is unverified.
2. Worker secrets: `GOOGLE_CLIENT_ID` (var), `GOOGLE_CLIENT_SECRET` (secret) and
   `BACKUP_KEY` (secret, 32 bytes base64url) — the same ones Drive uses.
3. Settings → Notifications → **Google Calendar** → *Connect Google Calendar*.
   Only the owner of a book may connect it.

When a setting is missing, the card says exactly which one:
`Calendar is not set up: owner action needed (GOOGLE_CLIENT_SECRET)`.

## Behaviour

- One calendar named **Family Finance Planner** per book, created on connect.
- Event title is `Task due: <title>`. Notes are written as-is; an amount is only
  added when the book turns on *Write amounts into event notes*.
- Saving a task with a due time creates or updates its event; the event id is
  stored in `google_events`, so a re-sync patches instead of duplicating.
- Deleting the task, clearing its due time, or marking it **Completed** deletes
  the event.
- A failed call is retried by the quarter-hour cron with an exponential backoff,
  up to five attempts. The last error is shown in Settings.
- **Disconnect** revokes the refresh token at Google, deletes the stored token
  and the mapping, and stops sync. Events already in the calendar are left
  alone; the card says so.

## Tests

`test/google-calendar.test.mjs` stubs every Google call: create, update, delete,
no duplicate on re-sync, expired-token refresh, 429 backoff, giving up after the
last attempt, disconnect stopping sync, scope/state/PKCE of the consent URL, and
a non-owner being refused.
