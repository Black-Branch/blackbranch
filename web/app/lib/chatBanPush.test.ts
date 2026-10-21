// Every ban and unban the ban route writes is pushed to stream-api's POST /chat/ban at once,
// so a banned platform chatter's lines stop within a second. A target with no site account is
// refused in words, never a 500. A fake stream-api records what arrives.
// Run: node --test app/lib/chatBanPush.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { chatBanBody, pushChatBan } from "./chatBanPush.ts";

async function fakeStreamApi(status = 200) {
  const got: { path: string; auth: string | undefined; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      got.push({ path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "null") });
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.STREAM_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.STREAM_API_SECRET = "test-secret";
  return { got, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("the bodies: platform-only by canonical; a site ban by the accounts it reached; an unban adds lift and no expiry", () => {
  assert.deepEqual(chatBanBody({ matrixIds: [], canonicalId: "abcdef012345", expiresAt: null, lift: false }),
    { canonicalId: "abcdef012345", expiresAt: null });
  assert.deepEqual(chatBanBody({ matrixIds: ["@casey:site.test"], canonicalId: null, expiresAt: "2026-10-21T00:10:00.000Z", lift: false }),
    { matrixIds: ["@casey:site.test"], expiresAt: "2026-10-21T00:10:00.000Z" });
  assert.deepEqual(chatBanBody({ matrixIds: ["@a:site.test", "@b:site.test"], canonicalId: "abcdef012345", expiresAt: null, lift: true }),
    { matrixIds: ["@a:site.test", "@b:site.test"], canonicalId: "abcdef012345", expiresAt: null, lift: true });
  assert.deepEqual(chatBanBody({ matrixIds: [], canonicalId: "abcdef012345", expiresAt: "x", lift: true }),
    { canonicalId: "abcdef012345", expiresAt: null, lift: true });
  assert.equal(chatBanBody({ matrixIds: [], canonicalId: null, expiresAt: null, lift: false }), null);
});

test("pushed to POST /chat/ban with the secret; the same ban twice (retry) is two harmless posts", async () => {
  const api = await fakeStreamApi();
  try {
    const body = chatBanBody({ matrixIds: [], canonicalId: "abcdef012345", expiresAt: null, lift: false });
    await pushChatBan(body);
    await pushChatBan(body);
    assert.equal(api.got.length, 2);
    for (const g of api.got) {
      assert.equal(g.path, "/chat/ban");
      assert.equal(g.auth, "Bearer test-secret");
      assert.deepEqual(g.body, { canonicalId: "abcdef012345", expiresAt: null });
    }
  } finally { await api.close(); }
});

test("stream-api refusing or down never throws — the ban is already written", async () => {
  const api = await fakeStreamApi(503);
  try {
    await pushChatBan(chatBanBody({ matrixIds: ["@casey:site.test"], canonicalId: null, expiresAt: null, lift: true }));
    assert.equal(api.got.length, 1);
  } finally { await api.close(); }
  process.env.STREAM_API_URL = "http://127.0.0.1:1"; // nothing listens
  await pushChatBan(chatBanBody({ matrixIds: [], canonicalId: "abcdef012345", expiresAt: null, lift: false }));
  await pushChatBan(null);
});

test("wiring: every ban and unban path of the route pushes; a non-member target is refused in words before any write", () => {
  const src = readFileSync(new URL("../api/mod/ban/route.ts", import.meta.url), "utf8");
  assert.equal(src.match(/await pushChatBan\(chatBanBody\(/g)?.length, 4, "platform-only ban, site ban, platform-only unban, site unban");
  assert.match(src, /matrixIds: targets\.filter\(\(_, i\) => results\[i\]!\.applied\)/, "only the accounts the ban reached");
  const refuse = src.indexOf("if (!member) return new Response(NOT_A_MEMBER, { status: 404 });");
  const insert = src.indexOf("INSERT INTO site.bans");
  assert.ok(refuse > 0, "the refusal exists");
  assert.match(src, /if \(member === null\) return unavailable\(\);/, "a failed read is 503, never a false refusal");
  assert.ok(src.indexOf("for (const t of targets) results.push(await banAccount(t, action));") > refuse && insert > 0);
  assert.ok("That isn't an account on this site — there is nothing to ban.".length < 120, "under every caller's length cap");
  assert.match(src.trimEnd(), /\}$/);
});
