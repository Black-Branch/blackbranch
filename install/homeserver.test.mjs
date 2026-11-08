// The thin Matrix client (install/matrix/homeserver.mjs) the bootstrap and the community reconciler
// share. Tests drive it with a recorded fake `fetch` and a fake `sleep`, so nothing waits and every
// request is visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClient, HomeserverError } from "./matrix/homeserver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://hs.example.test:8008";

/** A fetch that answers from `answers` in order (the last one repeats) and records each request. */
function fakeFetch(...answers) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const a = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body ?? {});
    return new Response(text, { status: a.status, headers: a.headers ?? {} });
  };
  return { f, seen };
}
const sleeps = () => { const s = []; return { s, sleep: async (ms) => { s.push(ms); } }; };

test("retries 429 with retry_after_ms", async () => {
  const { f, seen } = fakeFetch(
    { status: 429, body: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1234 } },
    { status: 429, body: { errcode: "M_LIMIT_EXCEEDED" }, headers: { "Retry-After": "2" } },
    { status: 200, body: { room_id: "!a:example.test" } },
  );
  const { s, sleep } = sleeps();
  const hs = makeClient({ base: BASE, token: "tok", fetch: f, sleep });
  assert.deepEqual(await hs.call("POST", "/createRoom", { name: "x" }), { room_id: "!a:example.test" });
  assert.equal(seen.length, 3);
  assert.deepEqual(s, [1234, 2000], "the server's wait, then Retry-After in seconds");
  assert.ok(seen.every((r) => r.body === JSON.stringify({ name: "x" })), "the same body each time");
});

test("gives up after five retries of a 429 and throws it", async () => {
  const { f, seen } = fakeFetch({ status: 429, body: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 10 } });
  const { s, sleep } = sleeps();
  const hs = makeClient({ base: BASE, token: "tok", fetch: f, sleep });
  await assert.rejects(hs.call("GET", "/account/whoami"), (e) => e instanceof HomeserverError && e.status === 429 && e.errcode === "M_LIMIT_EXCEEDED");
  assert.equal(seen.length, 6, "one try and five retries");
  assert.deepEqual(s, [10, 10, 10, 10, 10]);
  // A wait the server asks for is capped, so a bad header cannot hang a run.
  const big = fakeFetch({ status: 429, body: { retry_after_ms: 10_000_000 } }, { status: 200, body: {} });
  const w = sleeps();
  await makeClient({ base: BASE, token: "tok", fetch: big.f, sleep: w.sleep }).call("GET", "/x");
  assert.deepEqual(w.s, [60_000]);
});

test("sends the bearer token, JSON bodies, and Matrix's client path", async () => {
  const { f, seen } = fakeFetch({ status: 200, body: {} });
  const hs = makeClient({ base: `${BASE}/`, token: "tok", fetch: f, sleep: async () => {} });
  await hs.call("PUT", "/rooms/!r:example.test/state/m.room.name/", { name: "general" });
  await hs.call("GET", "/directory/room/%23general%3Aexample.test");
  await hs.call("GET", "/_matrix/media/v3/config");
  assert.equal(seen[0].url, `${BASE}/_matrix/client/v3/rooms/!r:example.test/state/m.room.name/`);
  assert.equal(seen[0].headers.Authorization, "Bearer tok");
  assert.equal(seen[0].headers["Content-Type"], "application/json");
  assert.equal(seen[1].headers["Content-Type"], undefined, "no body, no content type");
  assert.equal(seen[1].body, undefined);
  assert.equal(seen[2].url, `${BASE}/_matrix/media/v3/config`, "a full Matrix path is used as given");
});

test("appends user_id when masquerading", async () => {
  const { f, seen } = fakeFetch({ status: 200, body: {} });
  const hs = makeClient({ base: BASE, token: "as", asUserId: "@bot:example.test", fetch: f, sleep: async () => {} });
  await hs.call("GET", "/joined_rooms");
  await hs.call("GET", "/rooms/!r:example.test/messages", undefined, { dir: "b", limit: 5 });
  assert.equal(seen[0].url, `${BASE}/_matrix/client/v3/joined_rooms?user_id=%40bot%3Aexample.test`);
  const q = new URL(seen[1].url).searchParams;
  assert.deepEqual([q.get("dir"), q.get("limit"), q.get("user_id")], ["b", "5", "@bot:example.test"]);
  // Without a masquerade there is no user_id (the service account's own token acts as itself).
  const plain = fakeFetch({ status: 200, body: {} });
  await makeClient({ base: BASE, token: "as", fetch: plain.f, sleep: async () => {} }).call("GET", "/joined_rooms");
  assert.equal(plain.seen[0].url, `${BASE}/_matrix/client/v3/joined_rooms`);
});

test("whoami returns the user id", async () => {
  const { f, seen } = fakeFetch({ status: 200, body: { user_id: "@community:example.test", device_id: "D" } });
  const hs = makeClient({ base: BASE, token: "tok", fetch: f, sleep: async () => {} });
  assert.equal(await hs.whoami(), "@community:example.test");
  assert.equal(seen[0].url, `${BASE}/_matrix/client/v3/account/whoami`);
});

test("whoami_failure_is_fatal", async () => {
  // A revoked token, a missing registration, or an answer with no user: each throws, never "nobody".
  for (const answer of [
    { status: 401, body: { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" } },
    { status: 200, body: {} },
    new TypeError("fetch failed"),
  ]) {
    const { f } = fakeFetch(answer);
    const hs = makeClient({ base: BASE, token: "tok", fetch: f, sleep: async () => {} });
    await assert.rejects(hs.whoami(), HomeserverError, JSON.stringify(answer));
  }
  const { f } = fakeFetch({ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } });
  const e = await makeClient({ base: BASE, token: "tok", fetch: f, sleep: async () => {} }).whoami().catch((x) => x);
  assert.equal(e.status, 401); assert.equal(e.errcode, "M_UNKNOWN_TOKEN");
});

test("an error carries status, errcode and body; must() names what failed", async () => {
  const { f } = fakeFetch({ status: 403, body: { errcode: "M_FORBIDDEN", error: "You are not allowed" } });
  const hs = makeClient({ base: BASE, token: "tok", fetch: f, sleep: async () => {} });
  const e = await hs.call("PUT", "/rooms/!r/state/m.room.topic/", { topic: "x" }).catch((x) => x);
  assert.ok(e instanceof HomeserverError);
  assert.deepEqual([e.status, e.errcode], [403, "M_FORBIDDEN"]);
  assert.match(e.body, /You are not allowed/);
  const m = await hs.must("set the topic", hs.call("GET", "/x")).catch((x) => x);
  assert.ok(m instanceof HomeserverError);
  assert.match(m.message, /^set the topic: 403 \{"errcode":"M_FORBIDDEN"/);
  // A 2xx with an empty body is null from call(), and must() passes the value through.
  const empty = fakeFetch({ status: 200, body: "" });
  const hs2 = makeClient({ base: BASE, token: "tok", fetch: empty.f, sleep: async () => {} });
  assert.equal(await hs2.must("leave", hs2.call("POST", "/rooms/!r/leave", {})), null);
  // request() never throws on a status: the bootstrap reads 404s as answers.
  const nf = fakeFetch({ status: 404, body: { errcode: "M_NOT_FOUND" } });
  const r = await makeClient({ base: BASE, token: "tok", fetch: nf.f, sleep: async () => {} }).request("GET", "/directory/room/x");
  assert.deepEqual([r.status, r.json.errcode, typeof r.text], [404, "M_NOT_FOUND", "string"]);
});

test("restart: a fresh client holds no state from an earlier one", async () => {
  // Two clients in one process (the reconciler's second run after a restart): the masquerade and
  // token of one never leak into the other.
  const { f, seen } = fakeFetch({ status: 200, body: {} });
  const a = makeClient({ base: BASE, token: "one", asUserId: "@a:example.test", fetch: f, sleep: async () => {} });
  const b = makeClient({ base: BASE, token: "two", fetch: f, sleep: async () => {} });
  await a.call("GET", "/x"); await b.call("GET", "/x"); await a.call("GET", "/x");
  assert.deepEqual(seen.map((r) => [r.headers.Authorization, new URL(r.url).searchParams.get("user_id")]),
    [["Bearer one", "@a:example.test"], ["Bearer two", null], ["Bearer one", "@a:example.test"]]);
});

test("bootstrap.mjs talks to the homeserver only through this client", () => {
  const src = readFileSync(path.join(here, "matrix/bootstrap.mjs"), "utf8");
  // Vacuity: the scan read the whole file (its last line is the JSON answer).
  assert.match(src, /process\.stdout\.write\(`\$\{JSON\.stringify\(\{ hub, general, forum, created \}\)\}\\n`\);\n$/);
  assert.match(src, /^import \{ makeClient \} from "\.\/homeserver\.mjs";$/m);
  assert.doesNotMatch(src, /\bfetch\(/, "no fetch of its own");
});
