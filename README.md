# vgate (POC)

Trusted-agent OAuth broker — proof of concept for Google Docs.

## What this demonstrates

- MV3 browser extension (Chrome / Edge / Firefox 121+) that auto-completes a Google OAuth consent flow on behalf of the user.
- Content script clicks "Allow" on the consent screen (and clicks through the unverified-app warning while we're in POC test-mode).
- Service worker handles redirect interception, PKCE-protected code exchange, and token storage.
- Tokens land in `chrome.storage.session` — "try-mode": in-memory only, dies with the service worker.
- Demo API call: list the user's 10 most recently modified Google Docs via the Drive API.

## What this is NOT

- Not production-ready. `client_secret` is shipped in the extension. Acceptable POC compromise; production moves the token exchange server-side.
- Refresh tokens are requested (`access_type=offline`) but only stashed in session storage. The buy-tier path (durable refresh-token custody on the backend) is a TODO marker in `background.js`.
- Auto-click only handles the consent screen and unverified-app warning. MFA, login, and any other Google security challenge deliberately bypass auto-click and require the user.
- English-only button text matching. i18n is a TODO.
- The localhost redirect URI doesn't actually serve anything. The extension's `tabs.onUpdated` listener catches the navigation and extracts the code, but the tab is left open on a connection-refused page so dev users can see the full callback URL in the URL bar. For non-dev users we'd swap this for a bundled success page or a real hosted callback.

## Setup

### 1. Create a Google OAuth client

- Go to https://console.cloud.google.com/apis/credentials
- Create OAuth 2.0 Client ID → "Web application"
- Authorized redirect URI: `http://localhost:8765/vgate-callback`
- Copy the client ID and secret.

### 2. Configure the OAuth consent screen

- https://console.cloud.google.com/apis/credentials/consent
- User type: External (Testing)
- Add scopes: `openid`, `email`, `profile`, `drive.readonly`, `documents.readonly`
- Add your Google account under "Test users"

### 3. Enable the APIs

In your GCP project, enable:
- Google Drive API
- Google Docs API

### 4. Fill in config

```sh
cp src/config.example.js src/config.js
# edit src/config.js, paste in your client_id and client_secret
```

### 5. Load the extension

**Chrome / Edge:**

- Open `chrome://extensions` (or `edge://extensions`)
- Enable Developer mode (top right)
- Click "Load unpacked" → select this directory
- The extension ID the browser assigns is fine to ignore; we use a localhost redirect
- Note: extensions are scoped per-profile. If you use multiple Chrome profiles, load vgate in the profile where you're actually signed in to Google — extensions can't see across profiles, and the OAuth tab will open in whichever profile vgate is installed in.

**Firefox (121+):**

- Open `about:debugging` → "This Firefox" (left sidebar)
- Click "Load Temporary Add-on…" → select `manifest.json` in this directory
- **Caveat: this is temporary.** The extension disappears when you restart Firefox. For permanent install you need a signed `.xpi` (submit to [AMO](https://addons.mozilla.org/developers/) — free, signing usually takes hours), or use Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set to `false` in `about:config`.
- After install, you may need to grant host permissions for `accounts.google.com` via the extension icon — Firefox can treat declared host permissions as optional and require an explicit user opt-in.
- Older Firefox (<121): MV3 service workers + ES modules aren't supported. You'd need to refactor to event pages (`"background": { "scripts": [...] }`) and inline `pkce.js` and `config.js` into `background.js`. Not currently supported by this POC.

## Use

1. Click the vgate icon → popup opens.
2. Click "Connect Google" → a new tab opens to Google's auth flow.
3. Watch the content script click through: unverified-app warning → consent screen → redirect.
4. The tab closes itself when the redirect lands. Popup shows "connected".
5. Click "List my Docs" to call the Drive API and confirm the token works.
6. "Disconnect" revokes the token and clears session storage.

## Debugging

- **Service worker logs:**
  - Chrome/Edge: `chrome://extensions` → vgate → "Inspect views: service worker"
  - Firefox: `about:debugging` → "This Firefox" → vgate → "Inspect"
- **Content script logs**: open devtools on the accounts.google.com tab while it's open. Look for `[vgate-content]` lines. (Same in both browsers.)
- **Popup logs**: right-click the popup → Inspect. (Same in both browsers.)

## Troubleshooting

Symptom → where to look:

- **Click Connect, new tab opens, but the consent button is never clicked.** Open devtools on the accounts.google.com tab. If you see `[vgate-content] loaded` but no `clicked-allow` event, the button-finding heuristic isn't matching the current page — Google has likely changed the consent-screen markup. Update `findAllowButton()` in `src/content-consent.js`.
- **Unverified-app warning ("Google hasn't verified this app") never gets dismissed.** Same diagnostic: check for `clicked-advanced` / `clicked-proceed-unsafe` events in the content-script log. If absent, `findUnverifiedAdvanced()` / `findUnverifiedProceed()` need updating — Google has reworded these screens before.
- **"connect failed: CLIENT_ID not set".** You haven't copied `src/config.example.js` to `src/config.js` and filled in your credentials.
- **Token exchange fails with `redirect_uri_mismatch`.** The redirect URI in `src/config.js` must exactly match one of the URIs registered on your GCP OAuth client. Default is `http://localhost:8765/vgate-callback`.
- **Token exchange fails with `invalid_grant`.** Most often: clock skew, or the code has already been used (each authorization code is single-use). Try Connect again.
- **Drive API returns 403.** Either the Drive API isn't enabled in your GCP project, or your account isn't on the Test Users list for the consent screen.
- **"This site can't be reached" / connection-refused on the redirect tab.** Expected — nothing actually serves `http://localhost:8765`. The SW has already pulled the code out of the URL before the page tries to load; the tab is intentionally left open so you can see the full callback URL. Close it manually or just leave it.

## Known fragile bits

- `findAllowButton()` in `content-consent.js` matches button text. Google occasionally redesigns the consent screen; expect to revisit.
- `prompt=consent` is forced in the auth URL so the consent screen always appears for demo purposes. Remove this to get Google's normal silent-re-grant behavior on subsequent connects.
- If you change scopes after a connection has already been authorized, you may need to revisit Google Account → Security → Third-party apps and revoke the previous grant before reconnecting.
