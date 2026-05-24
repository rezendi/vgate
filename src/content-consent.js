// Content script — runs on accounts.google.com.
//
// Job: detect the OAuth consent screen and click "Allow" / "Continue" on the
// user's behalf. Click through the unverified-app warning too (it's noise for
// a POC under test-users). Deliberately do NOT auto-click MFA, login, or any
// other security challenge — those need the human present.
//
// The selectors here are fragile. Google occasionally redesigns the consent UI;
// expect to update findAllowButton() and friends. The MutationObserver pattern
// means we don't need to know exactly when the button appears — we react to it.
// English-only text matching for now; i18n is a TODO.

(() => {
  const LOG = (...args) => console.log('[vgate-content]', ...args);

  function classifyUrl() {
    const url = location.href;
    if (/\/signin\/(v\d+\/)?(challenge|identifier)/i.test(url)) return 'login-or-mfa';
    if (/\/signin\/oauth\/warning/i.test(url))                  return 'unverified-warning';
    if (/\/signin\/oauth\/consent|\/o\/oauth2\/v\d+\/auth/i.test(url)) return 'consent';
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

  function findAllowButton() {
    // Strategy 1: explicit data attributes (most stable when present).
    const byData = document.querySelector('[data-id="oauth-consent-allow"], button[jsname][data-action="allow"]');
    if (byData && isVisible(byData)) return byData;

    // Strategy 2: text match — English only for POC.
    const wanted = ['Allow', 'Continue', 'Allow access'];
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const text = (b.innerText || b.textContent || '').trim();
      if (wanted.includes(text) && isVisible(b)) return b;
    }
    return null;
  }

  function findUnverifiedAdvanced() {
    for (const b of document.querySelectorAll('button, [role="button"], a')) {
      if (/^Advanced$/i.test((b.innerText || '').trim()) && isVisible(b)) return b;
    }
    return null;
  }

  function findUnverifiedProceed() {
    for (const a of document.querySelectorAll('a, button, [role="button"]')) {
      const t = (a.innerText || '').trim();
      if (/^Go to .* \(unsafe\)$/i.test(t) && isVisible(a)) return a;
    }
    return null;
  }

  let clickedAllow = false;
  let clickedAdvanced = false;
  let clickedProceed = false;

  function tick() {
    const kind = classifyUrl();

    if (kind === 'login-or-mfa') {
      send('user-attention-needed', 'login or MFA — auto-click suppressed');
      return;
    }

    if (kind === 'unverified-warning') {
      // Two clicks: Advanced → Go to X (unsafe).
      if (!clickedAdvanced) {
        const adv = findUnverifiedAdvanced();
        if (adv) { adv.click(); clickedAdvanced = true; send('clicked-advanced'); }
      } else if (!clickedProceed) {
        const proceed = findUnverifiedProceed();
        if (proceed) { proceed.click(); clickedProceed = true; send('clicked-proceed-unsafe'); }
      }
      return;
    }

    if (kind === 'consent' && !clickedAllow) {
      const btn = findAllowButton();
      if (btn) { btn.click(); clickedAllow = true; send('clicked-allow'); }
    }
  }

  tick();
  const obs = new MutationObserver(tick);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 60_000);

  LOG('loaded, url kind:', classifyUrl());
})();
