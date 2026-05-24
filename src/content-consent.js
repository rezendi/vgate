// Content script — runs on accounts.google.com.
//
// Job: detect the OAuth consent screen and click "Allow" / "Continue" on the
// user's behalf. Click through the unverified-app warning too (it's noise for
// a POC under test-users). Deliberately do NOT auto-click MFA, login, or the
// account-chooser — those are security-sensitive choices for the user.
//
// English-only text matching for now; i18n is a TODO. Expect to revisit
// selectors as Google reworks the OAuth UI.

(() => {
  const LOG = (...args) => console.log('[vgate-content]', ...args);

  function classifyUrl() {
    const url = location.href;
    // Login + MFA challenges — DO NOT auto-click.
    if (/\/signin\/(v\d+\/)?(challenge|identifier)\b/i.test(url)) return 'login-or-mfa';
    // Unverified-app warning screen.
    if (/\/signin\/oauth\/warning/i.test(url))                    return 'unverified-warning';
    // Consent screen URL shapes observed:
    //   /signin/oauth/consent      (older naming)
    //   /signin/oauth/id           (current, as of 2025+)
    //   /o/oauth2/vN/auth/...      (legacy, sometimes still appears)
    // The /identifier sub-path under /o/oauth2/auth is the account chooser
    // and is left to the user.
    if (/\/signin\/oauth\/(consent|id)\b/i.test(url))             return 'consent';
    if (/\/o\/oauth2\/v\d+\/auth/i.test(url) && !/identifier/i.test(url)) return 'consent';
    return 'other';
  }

  function send(event, detail) {
    chrome.runtime
      .sendMessage({ type: 'consent-event', event, detail, url: location.href })
      .catch(() => {});
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function findClickableByText(labels) {
    const want = new Set(labels.map(s => s.toLowerCase()));
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (want.has(t) && isVisible(el)) return el;
    }
    return null;
  }

  function findClickableByRegex(re) {
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const t = (el.innerText || el.textContent || '').trim();
      if (re.test(t) && isVisible(el)) return el;
    }
    return null;
  }

  function findAllowButton() {
    // Strategy 1: explicit data attributes (most stable when present).
    const byData = document.querySelector('[data-id="oauth-consent-allow"], button[jsname][data-action="allow"]');
    if (byData && isVisible(byData)) return byData;
    // Strategy 2: text match — English only for POC.
    return findClickableByText(['Allow', 'Continue', 'Allow access']);
  }

  let warningClicked   = false;
  let advancedClicked  = false; // legacy two-step flow only
  let consentClicked   = false;
  const missLogged = new Set();

  function logMiss(kind) {
    if (missLogged.has(kind)) return;
    missLogged.add(kind);
    LOG(`recognized ${kind} screen but found no matching button — selectors may need updating`);
    send('selector-miss', kind);
  }

  function tick() {
    const kind = classifyUrl();

    if (kind === 'login-or-mfa') {
      send('user-attention-needed', 'login or MFA — auto-click suppressed');
      return;
    }

    if (kind === 'unverified-warning' && !warningClicked) {
      // Modern flow (2024+): a single "Continue" button, sometimes alongside
      // a "Back to safety" default. Click Continue.
      const cont = findClickableByText(['Continue']);
      if (cont) {
        cont.click();
        warningClicked = true;
        send('clicked-continue-unverified');
        return;
      }
      // Legacy flow: "Advanced" → "Go to X (unsafe)".
      if (!advancedClicked) {
        const adv = findClickableByText(['Advanced']);
        if (adv) {
          adv.click();
          advancedClicked = true;
          send('clicked-advanced');
          return;
        }
      } else {
        const proceed = findClickableByRegex(/^Go to .* \(unsafe\)$/i);
        if (proceed) {
          proceed.click();
          warningClicked = true;
          send('clicked-proceed-unsafe');
          return;
        }
      }
      logMiss('unverified-warning');
      return;
    }

    if (kind === 'consent' && !consentClicked) {
      const btn = findAllowButton();
      if (btn) {
        btn.click();
        consentClicked = true;
        send('clicked-allow');
        return;
      }
      logMiss('consent');
    }
  }

  tick();
  const obs = new MutationObserver(tick);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 60_000);

  LOG('loaded, url kind:', classifyUrl());
})();
