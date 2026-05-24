// vgate service worker — handles the OAuth dance and API calls.
//
// Flow:
//   1. popup → SW: { type: 'connect' }
//   2. SW generates PKCE verifier, opens Google authorize URL in a new tab
//   3. content-consent.js (running on accounts.google.com) auto-clicks Allow
//   4. Google redirects the tab to REDIRECT_URI?code=...
//   5. tabs.onUpdated catches the redirect, extracts code, closes the tab
//   6. SW exchanges code for tokens at oauth2.googleapis.com/token
//   7. tokens land in chrome.storage.session (try-mode: in-memory, dies with the SW)
//
// Buy-mode (durable refresh-token storage, backend custody) is a TODO — marked below.

import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, SCOPES, LOGIN_HINT } from './config.js';
import { generateCodeVerifier, deriveCodeChallenge } from './pkce.js';

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// In-flight state for the current OAuth attempt.
let pending = null; // { verifier, state, tabId }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'connect':       sendResponse({ ok: true, result: await connect() }); break;
        case 'disconnect':    sendResponse({ ok: true, result: await disconnect() }); break;
        case 'status':        sendResponse({ ok: true, result: await status() }); break;
        case 'list-docs':     sendResponse({ ok: true, result: await listDocs() }); break;
        case 'consent-event': sendResponse({ ok: true, result: await onConsentEvent(msg) }); break;
        default:              sendResponse({ ok: false, error: `unknown msg ${msg.type}` });
      }
    } catch (err) {
      console.error('[vgate] handler error:', err);
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

async function status() {
  const { tokens, connectedAt } = await chrome.storage.session.get(['tokens', 'connectedAt']);
  return { connected: !!tokens?.access_token, connectedAt: connectedAt ?? null };
}

async function connect() {
  if (!CLIENT_ID) {
    throw new Error('CLIENT_ID not set — copy src/config.example.js to src/config.js and fill it in');
  }

  const verifier  = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);
  const state     = crypto.randomUUID();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',  // request refresh_token (buy-tier hook lives here)
    prompt: 'consent'         // force consent screen each time, for demo
  });
  // Optional: pre-select an account to skip the chooser.
  if (LOGIN_HINT) params.set('login_hint', LOGIN_HINT);

  const authUrl = `${AUTH_URL}?${params.toString()}`;
  const tab = await chrome.tabs.create({ url: authUrl, active: true });

  pending = { verifier, state, tabId: tab.id };
  return { tabId: tab.id };
}

async function disconnect() {
  const { tokens } = await chrome.storage.session.get('tokens');
  if (tokens?.access_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.access_token)}`, {
        method: 'POST'
      });
    } catch (e) {
      console.warn('[vgate] revoke failed:', e);
    }
  }
  await chrome.storage.session.remove(['tokens', 'connectedAt']);
  pending = null;
  return { revoked: true };
}

// Watch for the redirect to REDIRECT_URI and pull the code out.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pending || tabId !== pending.tabId) return;
  const url = changeInfo.url || tab.url;
  if (!url || !url.startsWith(REDIRECT_URI)) return;

  const verifier = pending.verifier;
  const expectedState = pending.state;
  pending = null;

  // Intentionally NOT closing the tab. The user lands on a connection-refused page
  // at localhost:8765, which is fine for dev iteration — the URL bar still shows
  // the full callback URL (code + state), making it easy to see what happened.
  // For non-dev users we'd swap this for a bundled success page or a real hosted
  // callback. TODO: revisit when we have non-dev users.

  try {
    const u = new URL(url);
    const code  = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const error = u.searchParams.get('error');

    if (error) throw new Error(`OAuth error: ${error}`);
    if (!code) throw new Error('no code in redirect URL');
    if (state !== expectedState) throw new Error('OAuth state mismatch');

    const tokens = await exchangeCodeForTokens(code, verifier);
    await chrome.storage.session.set({ tokens, connectedAt: Date.now() });
    console.log('[vgate] connected; access_token issued, expires in', tokens.expires_in, 's');
    console.log('[vgate] granted scopes:', tokens.scope);
    // Sanity check: did we actually get what we asked for?
    const granted = new Set((tokens.scope || '').split(' '));
    const missing = SCOPES.filter(s => !granted.has(s));
    if (missing.length) {
      console.warn('[vgate] requested but NOT granted:', missing,
        '\n  Likely cause: these scopes are not added to the OAuth consent screen in GCP.',
        '\n  Fix: https://console.cloud.google.com/apis/credentials/consent → Edit App → Scopes → Add/Remove → search & check, then revoke the existing grant at https://myaccount.google.com/permissions and reconnect.');
    }

    // POC demonstration: immediately exercise the granted scopes by pulling
    // the user's recent Docs. Dumps to the SW console.
    try { await listDocs(); } catch (e) { console.error('[vgate] auto-list-docs failed:', e); }

    // TODO (buy-tier): forward refresh_token to backend here.
    // For try-mode POC we keep everything in session storage — dies with the SW.
  } catch (err) {
    console.error('[vgate] redirect handler failed:', err);
  }
});

async function exchangeCodeForTokens(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Logged for visibility — the content script clicks autonomously, SW just observes.
async function onConsentEvent(msg) {
  console.log('[vgate] consent event:', msg.event, msg.detail || '', msg.url || '');
  return { ack: true };
}

// Demo: list the user's 10 most recently modified Google Docs.
// Always logs the result to the SW console so it's visible to dev users
// regardless of whether the popup or the auto-after-connect path called us.
async function listDocs() {
  const { tokens } = await chrome.storage.session.get('tokens');
  if (!tokens?.access_token) throw new Error('not connected');

  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.document' and trashed=false",
    pageSize: '10',
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc'
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { authorization: `Bearer ${tokens.access_token}` }
  });
  if (!res.ok) {
    throw new Error(`Drive API failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const files = data.files || [];

  console.log(`[vgate] ${files.length} recent Google Docs:`);
  console.table(files.map(f => ({ name: f.name, id: f.id, modified: f.modifiedTime })));

  return files;
}
