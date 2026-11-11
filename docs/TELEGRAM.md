# Telegram alerts

One bot, many households. The bot is a single Bot API application owned by the
deployment; there is no per-user token and **no global chat id** that receives
everything. A chat only gets a household's alerts after the signed-in account
linked it, and every send resolves its recipients from D1 at that moment.

Code: `src/telegram.js` (linking, delivery, commands) and the
`/api/telegram*` routes in `src/worker.js`. Tables: `0007_telegram` in
`src/migrations/index.js`.

## 1. Create the bot

1. Open Telegram, message **@BotFather**, send `/newbot`, pick a name and a
   username ending in `bot`.
2. BotFather replies with a token that looks like `123456:ABC-DEF...`. That is
   `TELEGRAM_BOT_TOKEN`. Set it as a Worker secret — never in a file that is
   committed, and never in this document:

   ```cmd
   cd /d "D:\family planner"
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```

3. Put that public username (without the `@`) into `TELEGRAM_BOT_USERNAME` in
   `wrangler.jsonc`. It is not a secret; Settings uses it to open
   `https://t.me/<username>` when someone presses **Start chatting**, so keep it
   in step with BotFather when the bot is renamed.

4. Invent a long random string for `TELEGRAM_WEBHOOK_SECRET` (32+ characters is
   plenty). Telegram sends it back on every update, and the Worker rejects any
   request that does not carry it:

   ```cmd
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   To generate one without seeing it, run this in a second window and paste the
   output into the prompt above:

   ```cmd
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. Deploy, then register the webhook. `setWebhook` needs the bot token, so run it
   from a terminal where you paste the token into the environment for that one
   command (`set` in cmd.exe) rather than into a file:

   ```cmd
   set TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   set TELEGRAM_WEBHOOK_SECRET=the-same-string-you-set-above
   curl -s -X POST "https://api.telegram.org/bot%TELEGRAM_BOT_TOKEN%/setWebhook" -d "url=https://family-finance-planner.tarungudipatimadhav.workers.dev/api/telegram/webhook" -d "secret_token=%TELEGRAM_WEBHOOK_SECRET%"
   ```

   The reply is `{"ok":true,"result":true,"description":"Webhook was set"}`.

6. Check it took:

   ```cmd
   curl -s "https://api.telegram.org/bot%TELEGRAM_BOT_TOKEN%/getWebhookInfo"
   set TELEGRAM_BOT_TOKEN=
   set TELEGRAM_WEBHOOK_SECRET=
   ```

   `last_error_message` should be absent, and `pending_update_count` should fall
   to 0.

## 2. Link a chat

1. Sign in to the planner.
2. **Settings → Notifications → Telegram → Connect Telegram**. A ten-character
   code appears.
3. Press **Start chatting** in the card — it opens `https://t.me/<TELEGRAM_BOT_USERNAME>` —
   and send `/link <code>` (a bare code works too).
4. The reply is `Connected...`. The card now shows the chat and the preference.

Rules enforced by the Worker, not the UI:

- only the **hash** of a code is stored (`telegram_codes`), with its own salt;
- a code is single use and expires after **10 minutes**; asking for a new one
  deletes the previous unused code;
- one live Telegram identity per planner account and one planner account per
  Telegram identity (`telegram_links`, enforced by partial unique indexes);
- group chats are refused — a link belongs to one person's private chat;
- the Telegram numeric id and the private chat id are the only identity keys.
  Usernames and phone numbers are optional display data and never prove anything.

## 3. What gets sent

| Preference | Message |
| --- | --- |
| `generic` (default) | “You have a new planner alert. Open the app to view it.” |
| `detailed` | the notification title and body, e.g. `Overdue by 2 days: Electricity bill / ₹2,450 · UPI` |

Change it with the Settings card or by sending `/settings generic` or
`/settings detailed` to the bot. Amounts are never included until the account
opts in.

## 4. Delivery mechanics

`addNotification` (in `src/store.js`) writes one row to `telegram_events` — no
network call happens inside the request that saved the expense. The drain runs
in `runBackground` (after any write and on `/api/state`) and in the daily cron:

1. an unprocessed event is loaded with its notification;
2. the recipients are resolved now: members of that book, with a live,
   unblocked link;
3. `telegram_deliveries` is claimed with `INSERT OR IGNORE` on
   `(notification_id, link_id)` — a retry can never send the same alert twice;
4. the send result decides what happens next:

| Result | Action |
| --- | --- |
| 200 | `sent` |
| 403 (blocked) | `blocked`, and the link is marked so nothing else is attempted until `/start` |
| 400 (bad chat) | `failed` — retrying cannot fix it |
| 429 | `retry` after the `retry_after` Telegram asks for |
| 5xx / network | `retry` with exponential backoff, four attempts, then `failed` |

## 5. Commands

| Command | What it does |
| --- | --- |
| `/start`, `/help` | the list, plus whether this chat is connected |
| `/link CODE` | connect this chat to the planner account that issued the code |
| `/status` | account name, how many books, unread alerts, preview setting |
| `/settings [generic\|detailed]` | show or change the preview |
| `/unlink` | revoke the link; queued alerts for that chat are dropped |

Commands are limited to 30 per minute per Telegram user, and updates are
deduplicated by `update_id`, so Telegram's retries are harmless.

## 6. `TELEGRAM_CHAT_ID`


`TELEGRAM_CHAT_ID` exists **only** for an owner-run smoke test (send one message
to your own chat to prove the token works). Nothing in `src/` reads it: delivery
always resolves recipients from `telegram_links`. Keep it in your shell for the
test, not in the Worker. It is not referenced by `wrangler.jsonc`.

Smoke test, after the webhook is set:

```cmd
curl -s -X POST "https://api.telegram.org/bot%TELEGRAM_BOT_TOKEN%/sendMessage" -d "chat_id=%TELEGRAM_CHAT_ID%" -d "text=planner smoke test"
```

Then, in the bot: `/start`, `/link <code>`, `/status`, `/unlink`.

## 7. Unlink and removal

`/unlink` (or **Disconnect** in Settings) sets `revoked_at`, marks queued
deliveries `failed`, and every later send skips the chat. To remove Telegram from
the deployment entirely: delete both secrets, delete the webhook
(`curl .../deleteWebhook`), and the code falls back to “not set up”.
