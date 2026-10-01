/** Browser pairing. The secret is entered once and exchanged for an HttpOnly cookie. */
export const CONNECT_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to OpenAgents</title>
<body><main><h1>Connect to OpenAgents</h1><p>The desktop app connects automatically. For browser access, enter the token from this profile's .db.auth.json file.</p>
<form id="connect"><label>Local access token <input id="token" type="password" required autocomplete="off" size="64"></label><button>Connect</button></form>
<p id="status" role="status"></p></main><script src="/connect.js"></script></body></html>`;
export const CONNECT_JS = `document.getElementById('connect').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.getElementById('token');
  try {
    const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value.trim() }) });
    input.value = '';
    if (!response.ok) throw new Error('Could not connect. Check the token for this profile.');
    location.replace('/');
  } catch (error) { document.getElementById('status').textContent = error.message; }
});`;
