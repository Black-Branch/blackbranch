// ipKey — the per-address key every signed-out rate limit uses — believes a forwarded client
// address only from a TRUSTED proxy (WEB_TRUSTED_PROXIES, the rule stream-api's ws-hub uses for
// WS_TRUSTED_PROXIES). From anyone else the key is the socket's own address: a direct-mode
// install's limits were bypassable by sending a different CF-Connecting-IP / X-Forwarded-For per
// request. The socket address reaches a route through the peer stamp (ipKeyPeer.ts), which the
// server writes on every request, over anything a client sent.
// Run: env -u DATABASE_URL node --test app/lib/ipKey.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ipKey, PEER_HEADER } from "./rateLimit.ts";
import { installPeerStamp } from "./ipKeyPeer.ts";
import { stripComments } from "./testSource.ts";

const PROXY = [10, 0, 0, 9].join(".");
const req = (h: Record<string, string>) => new Request("http://site.test/x", { headers: h });

test("a spoofed header from an UNTRUSTED peer is ignored: the key is the socket address", () => {
  installPeerStamp();
  const env = { WEB_TRUSTED_PROXIES: PROXY };
  const peer = [192, 0, 2, 7].join(".");
  for (const spoof of [{ "cf-connecting-ip": "198.51.100.1" }, { "x-forwarded-for": "198.51.100.2" }, { "cf-connecting-ip": "198.51.100.3", "x-forwarded-for": "198.51.100.4" }] as Record<string, string>[]) {
    assert.equal(ipKey(req({ [PEER_HEADER]: peer, ...spoof }), env), `ip:${peer}`);
  }
});

test("from a TRUSTED proxy, its CF-Connecting-IP names the client; X-Forwarded-For is never read", () => {
  installPeerStamp();
  const env = { WEB_TRUSTED_PROXIES: `${PROXY}, ${[10, 0, 0, 10].join(".")}` };
  assert.equal(ipKey(req({ [PEER_HEADER]: PROXY, "cf-connecting-ip": "198.51.100.1" }), env), "ip:198.51.100.1");
  assert.equal(ipKey(req({ [PEER_HEADER]: `::ffff:${PROXY}`, "cf-connecting-ip": "198.51.100.1" }), env), "ip:198.51.100.1", "a v4-mapped peer");
  assert.equal(ipKey(req({ [PEER_HEADER]: PROXY, "x-forwarded-for": "198.51.100.2" }), env), `ip:${PROXY}`);
  assert.equal(ipKey(req({ [PEER_HEADER]: PROXY }), env), `ip:${PROXY}`);
  // Nobody is trusted when the list is empty — the default.
  assert.equal(ipKey(req({ [PEER_HEADER]: PROXY, "cf-connecting-ip": "198.51.100.1" }), {}), `ip:${PROXY}`);
});

test("an IPv6 client is one key per /64 — rotating inside its prefix is not a fresh bucket", () => {
  installPeerStamp();
  const a = ipKey(req({ [PEER_HEADER]: "2001:db8:1:2::1" }), {});
  const b = ipKey(req({ [PEER_HEADER]: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }), {});
  assert.equal(a, b);
  assert.equal(a, "ip:2001:db8:1:2::/64");
  assert.notEqual(ipKey(req({ [PEER_HEADER]: "2001:db8:1:3::1" }), {}), a);
});

test("the stamp is the SERVER's: a client-sent peer header is overwritten with the socket address", async () => {
  installPeerStamp();
  const seen: (string | undefined)[] = [];
  const server = http.createServer((rq, rs) => { seen.push(rq.headers[PEER_HEADER] as string | undefined); rs.end("ok"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    await fetch(`http://127.0.0.1:${port}/`, { headers: { [PEER_HEADER]: "203.0.113.9", "cf-connecting-ip": "203.0.113.9" } }).then((r) => r.text());
    assert.deepEqual(seen, ["127.0.0.1"]);
  } finally {
    server.close();
  }
});

test("no stamp on the request: one shared key, never a header the client chose", () => {
  installPeerStamp();
  assert.equal(ipKey(req({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" }), { WEB_TRUSTED_PROXIES: PROXY }), "ip:unknown");
});

test("boot installs the stamp", () => {
  const raw = readFileSync(join(process.cwd(), "instrumentation.ts"), "utf8");
  assert.match(raw, /\n\}\n?$/, "END not read");
  assert.match(stripComments(raw), /const \{ installPeerStamp \} = await import\("@\/app\/lib\/ipKeyPeer"\);\s*installPeerStamp\(\);/);
});
