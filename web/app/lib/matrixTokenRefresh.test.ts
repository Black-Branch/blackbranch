// Ticket #194: one expired or replaced access token stopped the community for good. The SDK answers
// M_UNKNOWN_TOKEN on /sync by STOPPING its sync loop (sync.js shouldAbortSync) unless the client was
// built with a refresh function; the old handler then fetched a new token and called
// retryImmediately(), a no-op on a stopped loop. Reproduced on the throwaway pair: one 401 on the
// first /sync → "Couldn't reach the community" with no further /sync, until a page reload.
// The site holds the refresh token server-side (/api/matrix/token refreshes it), so the client is
// built with a placeholder refresh token and a refresh function that asks the site.
//
// The SDK tests below are REAL executions of matrix-js-sdk's request path (createClient →
// http.authedRequest → TokenRefresher) against a fake homeserver fetch, not a model of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient, MatrixError, TokenRefreshLogoutError } from "matrix-js-sdk";
import { SERVER_HELD_REFRESH_TOKEN, serverTokenRefresher, type FreshToken } from "./matrixTokenRefresh.ts";
import { stripComments } from "./testSource.ts";

const HS = "https://hs.test";
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const unknownToken = () => new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "Token is not active", soft_logout: false }), { status: 401, headers: { "content-type": "application/json" } });

/** A homeserver that accepts exactly the tokens in `live`, recording which token each request carried. */
function homeserver(live: Set<string>) {
  const seen: string[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    seen.push(`${new URL(String(input)).pathname} ${token}`);
    return live.has(token) ? ok({ next_batch: "s1" }) : unknownToken();
  };
  return { fetchFn: fetchFn as typeof fetch, seen };
}

function siteTokens(answers: (FreshToken | null)[]) {
  let calls = 0;
  return { fetch: async () => { calls++; return answers.shift() ?? null; }, calls: () => calls };
}

test("the refresher hands the SDK the site's current token and keeps the refresh token server-side", async () => {
  const site = siteTokens([{ accessToken: "B", expiresAt: 1 }]);
  const fresh: FreshToken[] = [];
  const refresh = serverTokenRefresher({ fetchFresh: site.fetch, current: () => "A", onFresh: (t) => fresh.push(t), LogoutError: TokenRefreshLogoutError });
  assert.deepEqual(await refresh(), { accessToken: "B", refreshToken: SERVER_HELD_REFRESH_TOKEN });
  assert.deepEqual(fresh, [{ accessToken: "B", expiresAt: 1 }], "the proactive refresh timer is re-armed from the new expiry");
});

test("no answer from the site is transient (the SDK retries later); the SAME refused token back is a dead session", async () => {
  const none = serverTokenRefresher({ fetchFresh: async () => null, current: () => "A", onFresh: () => {}, LogoutError: TokenRefreshLogoutError });
  await assert.rejects(none(), (e: unknown) => e instanceof Error && !(e instanceof TokenRefreshLogoutError));
  const same = serverTokenRefresher({ fetchFresh: async () => ({ accessToken: "A", expiresAt: 1 }), current: () => "A", onFresh: () => {}, LogoutError: TokenRefreshLogoutError });
  await assert.rejects(same(), TokenRefreshLogoutError, "retrying the token the homeserver just refused would loop forever");
});

test("the defect: a client built WITHOUT a refresh function surfaces M_UNKNOWN_TOKEN to the sync loop (which then stops)", async () => {
  const hs = homeserver(new Set(["B"]));
  const client = createClient({ baseUrl: HS, accessToken: "A", userId: "@a:hs.test", deviceId: "D", fetchFn: hs.fetchFn });
  await assert.rejects(client.http.authedRequest("GET" as never, "/sync"), (e: unknown) => e instanceof MatrixError && e.errcode === "M_UNKNOWN_TOKEN");
});

test("retry: a request refused for its token is retried once with the site's fresh token and succeeds", async () => {
  const hs = homeserver(new Set(["B"]));
  const site = siteTokens([{ accessToken: "B", expiresAt: 1 }]);
  const own: { client?: ReturnType<typeof createClient> } = {};
  const client = own.client = createClient({
    baseUrl: HS, accessToken: "A", userId: "@a:hs.test", deviceId: "D", fetchFn: hs.fetchFn,
    refreshToken: SERVER_HELD_REFRESH_TOKEN,
    tokenRefreshFunction: serverTokenRefresher({ fetchFresh: site.fetch, current: () => own.client!.getAccessToken(), onFresh: () => {}, LogoutError: TokenRefreshLogoutError }),
  });
  assert.deepEqual(await client.http.authedRequest("GET" as never, "/sync"), { next_batch: "s1" });
  assert.deepEqual(hs.seen, ["/_matrix/client/v3/sync A", "/_matrix/client/v3/sync B"]);
  assert.equal(client.getAccessToken(), "B", "later requests carry the new token");
  assert.equal(site.calls(), 1);
});

test("restart: the token is replaced again later (another refresh rotated it) and the client recovers again", async () => {
  const live = new Set(["B"]);
  const hs = homeserver(live);
  const site = siteTokens([{ accessToken: "B", expiresAt: 1 }, { accessToken: "C", expiresAt: 2 }]);
  const own: { client?: ReturnType<typeof createClient> } = {};
  const client = own.client = createClient({
    baseUrl: HS, accessToken: "A", userId: "@a:hs.test", deviceId: "D", fetchFn: hs.fetchFn,
    refreshToken: SERVER_HELD_REFRESH_TOKEN,
    tokenRefreshFunction: serverTokenRefresher({ fetchFresh: site.fetch, current: () => own.client!.getAccessToken(), onFresh: () => {}, LogoutError: TokenRefreshLogoutError }),
  });
  await client.http.authedRequest("GET" as never, "/sync");
  live.clear(); live.add("C"); // MAS revokes B the moment anything refreshes this session
  assert.deepEqual(await client.http.authedRequest("GET" as never, "/sync"), { next_batch: "s1" });
  assert.equal(client.getAccessToken(), "C");
  assert.equal(site.calls(), 2);
});

test("a dead session (the site still holds the refused token) ends the request as M_UNKNOWN_TOKEN instead of looping", async () => {
  const hs = homeserver(new Set());
  const site = siteTokens([{ accessToken: "A", expiresAt: 1 }]);
  const own: { client?: ReturnType<typeof createClient> } = {};
  const client = own.client = createClient({
    baseUrl: HS, accessToken: "A", userId: "@a:hs.test", deviceId: "D", fetchFn: hs.fetchFn,
    refreshToken: SERVER_HELD_REFRESH_TOKEN,
    tokenRefreshFunction: serverTokenRefresher({ fetchFresh: site.fetch, current: () => own.client!.getAccessToken(), onFresh: () => {}, LogoutError: TokenRefreshLogoutError }),
  });
  await assert.rejects(client.http.authedRequest("GET" as never, "/sync"), (e: unknown) => e instanceof MatrixError && e.errcode === "M_UNKNOWN_TOKEN");
  assert.equal(hs.seen.length, 1, "no second request with the same refused token");
});

test("the provider builds its client with the site refresher", () => {
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MatrixClientContext.tsx"), "utf8");
  assert.match(raw.slice(-300), /<\/Ctx\.Provider>\s*\);\s*}\s*$/, "MatrixClientContext.tsx did not end as expected — a truncated read makes the scan below vacuous");
  const src = stripComments(raw);
  const create = src.slice(src.indexOf("const mxClient = createClient({"), src.indexOf("bootingRef.current = mxClient;"));
  assert.match(create, /refreshToken: SERVER_HELD_REFRESH_TOKEN,/);
  assert.match(create, /tokenRefreshFunction: serverTokenRefresher\(\{/);
  assert.match(create, /current: \(\) => mxClient\.getAccessToken\(\)/, "the refused token is the client's own, read at refresh time");
  assert.match(create, /LogoutError: TokenRefreshLogoutError/);
  assert.doesNotMatch(src, /retryImmediately\(\)/, "the old recovery called retryImmediately() on a sync loop the SDK had already stopped");
});
