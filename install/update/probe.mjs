// The update's live probes, beside the doctor's checks: a WebSocket frame from
// stream-api, the site starting a sign-in that the account server (MAS) accepts, and — when the
// host hands one over on stdin — a sign-in token MAS issued, used against the homeserver through
// its public address and ended. `blackbranch health` runs this with node inside a one-off web
// container (the site's own network view and environment: its addresses, and in lab mode its trust
// in the box's own certificate authority). Imports nothing but node's own globals.
//
// Prints one line of JSON: { ws, signin, whoami } each { ok: true|false|null, detail }; exit 0
// when nothing is false. null = not checked (said why), never a failure.

const WAIT_MS = Number(process.env.BB_PROBE_WAIT_MS || 15000);
const result = {};

function timeout(ms) { return AbortSignal.timeout(ms); }

async function probeWs() {
  const url = process.env.BB_PROBE_WS || "ws://stream-api:3001/";
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch { /* closing */ } resolve(v); } };
    const ws = new WebSocket(url);
    const t = setTimeout(() => finish({ ok: false, detail: `no frame within ${WAIT_MS / 1000} s` }), WAIT_MS);
    ws.addEventListener("message", (e) => {
      clearTimeout(t);
      let type = "a frame";
      try { const j = JSON.parse(String(e.data)); if (j && typeof j.type === "string") type = `a ${j.type.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)} frame`; } catch { /* not JSON */ }
      finish({ ok: true, detail: `${type} on connect` });
    });
    ws.addEventListener("error", () => { clearTimeout(t); finish({ ok: false, detail: "the socket did not open" }); });
    ws.addEventListener("close", () => { clearTimeout(t); finish({ ok: false, detail: "the socket closed before a frame" }); });
  });
}

async function probeSignin() {
  const issuer = process.env.MATRIX_OAUTH_ISSUER || "";
  let start;
  try {
    const r = await fetch(`${process.env.BB_PROBE_SITE || "http://web:3000"}/api/auth/mas-initiate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: `BBHEALTH${Date.now().toString(36).toUpperCase()}` }), signal: timeout(WAIT_MS),
    });
    if (r.status !== 200) return { ok: false, detail: `the site's sign-in start answered ${r.status}` };
    start = await r.json();
  } catch { return { ok: false, detail: "the site's sign-in start did not answer" }; }
  let url;
  try { url = new URL(start.authorizationUrl); } catch { return { ok: false, detail: "the site gave no sign-in address" }; }
  if (!issuer || url.origin !== new URL(issuer).origin) return { ok: false, detail: "the sign-in address is not this site's account server" };
  try {
    const r = await fetch(url, { redirect: "manual", signal: timeout(WAIT_MS) });
    if (r.status >= 300 && r.status < 400) return { ok: true, detail: `the account server accepted the site's sign-in request (${r.status})` };
    return { ok: false, detail: `the account server answered the site's sign-in request with ${r.status}` };
  } catch { return { ok: false, detail: "the account server did not answer the site's sign-in request" }; }
}

async function probeWhoami(token, expect) {
  if (!token) return { ok: null, detail: "no account to sign in with yet (setup has not made the first admin)" };
  const base = process.env.MATRIX_HOMESERVER_URL || "";
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const r = await fetch(`${base}/_matrix/client/v3/account/whoami`, { headers: auth, signal: timeout(WAIT_MS) });
    const j = r.ok ? await r.json() : null;
    if (!j || j.user_id !== expect) return { ok: false, detail: `a token the account server issued was refused by the homeserver (${r.status})` };
    return { ok: true, detail: "a token the account server issued works on the homeserver" };
  } catch { return { ok: false, detail: "the homeserver did not answer" }; }
  finally {
    try { await fetch(`${base}/_matrix/client/v3/logout`, { method: "POST", headers: auth, signal: timeout(WAIT_MS) }); } catch { /* best effort */ }
  }
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const [token = "", expect = ""] = Buffer.concat(chunks).toString("utf8").trim().split(/\s+/);
result.ws = await probeWs();
result.signin = await probeSignin();
result.whoami = await probeWhoami(/^mct_[A-Za-z0-9_]+$/.test(token) ? token : "", expect);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(Object.values(result).some((r) => r.ok === false) ? 1 : 0);
