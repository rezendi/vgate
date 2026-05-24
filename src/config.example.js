// Copy this file to src/config.js and fill in the values.
//
// Setup steps:
//
// 1. Go to https://console.cloud.google.com/apis/credentials
//    Create OAuth 2.0 Client ID, type "Web application"
//    Add authorized redirect URI:  http://localhost:8765/vgate-callback
//
// 2. Configure the OAuth consent screen
//    (https://console.cloud.google.com/apis/credentials/consent)
//    - User type: External (Testing)
//    - Add scopes: drive.readonly, documents.readonly, openid, email, profile
//    - Add yourself as a Test User
//
// 3. Enable APIs in your project: "Google Drive API" and "Google Docs API"
//
// 4. Copy this file to src/config.js and paste your client_id / client_secret below.
//
// POC compromise: client_secret is shipped in the extension. Public clients
// shouldn't do this — production should move the token exchange server-side.
// PKCE on top is defense-in-depth (and required regardless).

export const CLIENT_ID = '';
export const CLIENT_SECRET = '';
export const REDIRECT_URI = 'http://localhost:8765/vgate-callback';

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly'
];
