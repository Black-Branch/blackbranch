// The one small Matrix client the install's scripts share (bootstrap.mjs, the community reconciler).
// Plain fetch, no SDK. Every call carries the bearer token; an appservice that acts as another user
// in its namespace passes `asUserId` and every request gets `?user_id=` (the masquerade). The
// community service account is the registration's own sender, so its token acts as itself and
// needs no masquerade (Spike 0.1: its display name is set with a plain bearer PUT).
//
//   const hs = makeClient({ base: "http://synapse:8008", token });
//   await hs.whoami();                         // the token's user id, or throws
//   await hs.call("POST", "/createRoom", body) // the JSON answer, or throws HomeserverError
//   await hs.request("GET", path)              // {status, json, text}: never throws on a status
//
// A 429 is retried up to five times, waiting what the server asks (retry_after_ms, or Retry-After in
// seconds; at most a minute each), so a rate-limited run slows down instead of failing. A caller can
// ask for fewer tries and a shorter wait (`retries`, `maxWaitMs`) and for a wait longer than that to
// be answered at once rather than cut short (`longWait: "answer"`): a retry before the server's own
// time is only refused again.

const CLIENT = "/_matrix/client/v3";
const RETRIES = 5;
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 60_000;

/** A homeserver answered outside 2xx (status 0: it did not answer at all). `body` is the raw text. */
export class HomeserverError extends Error {
  constructor(status, errcode, body, message) {
    super(message ?? `homeserver ${status}${errcode ? ` ${errcode}` : ""}: ${String(body).slice(0, 200)}`);
    this.name = "HomeserverError";
    this.status = status;
    this.errcode = errcode;
    this.body = body;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the server asks to wait, uncapped (the caller caps it). */
function waitFor(res, json) {
  const ms = Number(json?.retry_after_ms);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const s = Number(res.headers.get("retry-after"));
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  return DEFAULT_WAIT_MS;
}

export function makeClient({ base, token, asUserId = null, fetch = globalThis.fetch, sleep = realSleep,
  retries = RETRIES, maxWaitMs = MAX_WAIT_MS, longWait = "cap" }) {
  const root = String(base ?? "").replace(/\/+$/, "");

  function urlOf(path, query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) params.set(k, String(v));
    if (asUserId) params.set("user_id", asUserId);
    // The path is the caller's, character for character (the caller encodes room ids and aliases).
    const q = params.toString();
    return `${root}${path.startsWith("/_matrix/") ? path : `${CLIENT}${path}`}${q ? `?${q}` : ""}`;
  }

  /** One request, 429s retried; the answer whatever its status. A network failure throws. */
  async function request(method, path, body, query) {
    const hasBody = body !== undefined && body !== null;
    const init = {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(hasBody ? { "Content-Type": "application/json" } : {}) },
      body: hasBody ? JSON.stringify(body) : undefined,
    };
    const url = urlOf(path, query);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (res.status === 429 && attempt < retries) {
        const wait = waitFor(res, json);
        if (wait > maxWaitMs && longWait === "answer") return { status: res.status, json, text };
        await sleep(Math.min(wait, maxWaitMs));
        continue;
      }
      return { status: res.status, json, text };
    }
  }

  /** The JSON answer of a 2xx (null when empty); anything else throws HomeserverError. */
  async function call(method, path, body, query) {
    let r;
    try { r = await request(method, path, body, query); } catch (e) {
      throw new HomeserverError(0, null, e instanceof Error ? e.message : String(e), `the homeserver did not answer (${e instanceof Error ? e.message : e})`);
    }
    if (r.status < 200 || r.status > 299) throw new HomeserverError(r.status, r.json?.errcode ?? null, r.text);
    return r.json;
  }

  /** Await `promise`; a HomeserverError is re-thrown with `what` in front ("create #general: 403 …"). */
  async function must(what, promise) {
    try { return await promise; } catch (e) {
      if (e instanceof HomeserverError) throw new HomeserverError(e.status, e.errcode, e.body, `${what}: ${e.status} ${String(e.body).slice(0, 200)}`);
      throw e;
    }
  }

  /** The token's user id. Throws when the token is refused or the answer names nobody. */
  async function whoami() {
    const j = await call("GET", "/account/whoami");
    const id = j?.user_id;
    if (typeof id !== "string" || !id) throw new HomeserverError(200, null, JSON.stringify(j), "whoami: the homeserver named no user for this token");
    return id;
  }

  return { request, call, must, whoami };
}
