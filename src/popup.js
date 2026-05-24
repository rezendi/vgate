const $ = (id) => document.getElementById(id);

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || 'unknown error');
  return res.result;
}

async function refreshStatus() {
  try {
    const s = await send('status');
    $('status').textContent = s.connected
      ? `connected (try-mode token in session storage; since ${new Date(s.connectedAt).toLocaleTimeString()})`
      : 'not connected';
  } catch (e) {
    $('status').textContent = 'error: ' + e.message;
  }
}

$('connect').addEventListener('click', async () => {
  $('output').textContent = 'opening Google consent…';
  try {
    await send('connect');
    // The connect message returns as soon as the tab opens. The real completion
    // happens when the redirect lands and the SW exchanges the code. Poll status.
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const s = await send('status');
        if (s.connected) {
          clearInterval(poll);
          $('output').textContent = 'connected!';
          refreshStatus();
        } else if (tries > 60) {
          clearInterval(poll);
          $('output').textContent = 'timed out waiting for redirect (check the SW console for errors)';
        }
      } catch (e) {
        clearInterval(poll);
        $('output').textContent = 'status check failed: ' + e.message;
      }
    }, 1000);
  } catch (e) {
    $('output').textContent = 'connect failed: ' + e.message;
  }
});

$('disconnect').addEventListener('click', async () => {
  try {
    await send('disconnect');
    $('output').textContent = 'disconnected.';
    refreshStatus();
  } catch (e) {
    $('output').textContent = 'disconnect failed: ' + e.message;
  }
});

$('list-docs').addEventListener('click', async () => {
  $('output').textContent = 'fetching…';
  try {
    const docs = await send('list-docs');
    if (!docs.length) { $('output').textContent = '(no Docs found)'; return; }
    $('output').textContent = docs
      .map(d => `• ${d.name}\n  ${d.id}\n  modified: ${d.modifiedTime}`)
      .join('\n\n');
  } catch (e) {
    $('output').textContent = 'list-docs failed: ' + e.message;
  }
});

refreshStatus();
