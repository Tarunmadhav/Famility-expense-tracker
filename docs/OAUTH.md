# Social sign-in

Google sign-in (and the optional Facebook and GitHub providers) share one flow, described in
`src/oauth.js`. Nothing here is active until the matching Worker secrets exist:
`GET /api/auth/status` reports `configured: false` for a provider without them and
the buttons stay hidden.

## The flow, and why it is shaped this way

    app ──POST /api/auth/oauth/start──▶ Worker      (state + PKCE S256, 10 min TTL)
    app ──opens the returned URL──▶ system browser  (Chrome / Custom Tab)
    browser ──▶ provider ──▶ GET /api/auth/oauth/callback/<provider>
                                   │ code exchanged server-side with the verifier
                                   │ identity resolved, one-time ticket minted
                                   ▼ 302
                        GET /api/auth/oauth/finish?ticket=…
                                   │ ticket burned, session cookie set
                                   ▼ 302 /
    WebView ◀── App Link (android:autoVerify) ── the app loads that URL itself

The provider page never runs inside the WebView. Two reasons: Google refuses to
render its sign-in page in an embedded WebView, and a cookie set in the browser's
jar is invisible to the app's own jar. The ticket bridges the two: it is 32 random
bytes, valid for 60 seconds, usable once (the `DELETE` that consumes it decides
the winner), and useless for anything except creating one session.

`POST /api/auth/oauth/start` is same-origin only and rate limited (30 per ten
minutes per IP). The callback validates that the `state` exists, belongs to the
same provider, and is younger than ten minutes. Replaying it fails, because the
state row is deleted as it is read.

## Account-linking rule

> **One verified email, one account.** A provider identity that has signed in
> before always keeps its account. A confirmed address that already has an
> account links to it, whichever provider it arrives through. A confirmed address
> with no account creates one. An unconfirmed address does neither.

In order (`resolveOauthAccount` in `src/store.js`):

1. `oauth_links(provider, provider_id)` exists → that account, no matter what
   address the provider reports now. An address is not an identity; this is what
   stops a changed or recycled provider address from moving an account.
2. No link, and the provider has not confirmed the address → `403`, nothing is
   created and nothing is linked.
3. No link, confirmed address, `credentials.email` matches → link the provider to
   that account (`outcome: linked-by-email`). So signing up with a password and
   later using "Sign in with Google" on the same address lands in the same
   household, not a second empty one.
4. No link, confirmed address, no account → create one with an empty password
   (`outcome: created`). Only the provider can sign into it until the owner sets a
   password in Settings.

The outcome is written to the audit log as `auth.login` with
`detail: "<provider>:<outcome>"`.

Consequences worth knowing:

- Because linking is by address, **the provider must be trusted to verify it**.
  Google's `email_verified` claim is required (Facebook and GitHub, still present
  as optional providers, follow analogous rules; GitHub is read through
  `/user/emails` and only a `verified` entry is accepted).
- Two different provider identities on the same address are the *same* account.
  That is the intended behaviour, and it is why the rule keys on the address.
- An account created by a provider has no password. Setting one later adds a
  second way in without unlinking the provider.

## Provider setup

Redirect URI for every provider: `https://<worker-host>/api/auth/oauth/callback/<provider>`
where `<provider>` is `google` (the only provider with credentials wired),
`facebook` or `github` (optional, no credentials).

| Provider | Secrets | Notes |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID` (var in `wrangler.jsonc`), `GOOGLE_CLIENT_SECRET` (secret) | Web application client. The same pair is used for Drive backup (`drive.appdata`). Add the APK's signing SHA-1 to the Android client if you also want native Google sign-in later. |
| Facebook | `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | Add the key hash printed by `keytool -exportcert … \| openssl sha1 -binary \| openssl base64` to the app in the Meta console. |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | OAuth App. No PKCE (GitHub does not accept it); `state` still protects the flow. |

Set them with `npx wrangler secret put NAME`. Nothing provider-specific belongs in
the repository.

## Android App Links

`/.well-known/assetlinks.json` is served from the Worker. Set one Worker variable,
`ANDROID_SHA256`, to the colon-separated SHA-256 fingerprint(s) of the certificate
that signs the APK:

    keytool -list -v -keystore <keystore> -alias <alias> | grep SHA256

Without it the endpoint answers 404, Android cannot verify the domain, and the
return leg shows a chooser ("open with Family Planner") before the app takes over.
The flow still completes. With a release keystore in place, verification is
automatic after the first install.

The link only works for the host in `AndroidManifest.xml`; moving the Worker means
updating that host and `android/gradle.properties` together.
