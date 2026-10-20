// `/purge <user> <since>` driven through the REAL command runner, and the body it sends read by the
// SAME parser the route uses — so a field the command names and the route does not read fails
// here. The command once sent `sinceMinutes` while the route read `windowHours`: every purge
// cleared 24 hours whatever was typed.
// Run: node --test app/lib/commands/purgeCommand.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../testTsx.ts"; // resolves run.ts's extensionless and "@/" imports
import { parsePurgeRequest, PURGE_MAX_MINUTES } from "../modRequests.ts";
import { stripComments } from "../testSource.ts";

const { createCommandRunner } = await import("./run.ts");
const { modPurge } = await import("../modQuickActions.ts");

type Call = { url: string; body: unknown };
function stubFetch() {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, purged: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}
const mod = { isMod: true, isAdmin: false };

function purgeBodies(calls: Call[]) {
  return calls.filter((c) => c.url === "/api/mod/purge").map((c) => c.body);
}

test("/purge <user> 10m reaches the route as a 10-minute window, not 24 h", async () => {
  const calls = stubFetch();
  const notices: string[] = [];
  const { runCommand } = createCommandRunner({ setSendError: () => {}, showNotice: (t) => notices.push(t) });
  await runCommand("/purge casey 10m", mod);
  const [body] = purgeBodies(calls);
  assert.ok(body, "the command posted to the purge route");
  const read = parsePurgeRequest(body);
  assert.equal(read?.windowMinutes, 10);
  assert.match(String(read?.targetId), /^@casey:/);
  assert.match(notices.join("\n"), /last 10m/);
});

test("/purge <user> 2h is 120 minutes; bare /purge <user> is the 24 h default", async () => {
  const calls = stubFetch();
  const { runCommand } = createCommandRunner({ setSendError: () => {}, showNotice: () => {} });
  await runCommand("/purge casey 2h", mod);
  await runCommand("/purge casey", mod);
  const [two, bare] = purgeBodies(calls).map((b) => parsePurgeRequest(b)?.windowMinutes);
  assert.equal(two, 120);
  assert.equal(bare, PURGE_MAX_MINUTES);
});

test("the ⋯ menu's and the card's purge (modPurge) send a window the route reads", async () => {
  const calls = stubFetch();
  await modPurge({ id: 1, platform: "twitch", canonicalId: "0123456789ab" }, 60);
  assert.deepEqual(parsePurgeRequest(purgeBodies(calls)[0]), { targetId: "0123456789ab", windowMinutes: 60 });
});

test("the parser caps at 24 h and refuses a body with no target or a bad window", () => {
  assert.equal(parsePurgeRequest({ targetId: "@a:site.test", windowMinutes: 99999 })?.windowMinutes, PURGE_MAX_MINUTES);
  assert.equal(parsePurgeRequest({ windowMinutes: 10 }), null);
  assert.equal(parsePurgeRequest({ targetId: "@a:site.test", windowMinutes: 0 }), null);
  assert.equal(parsePurgeRequest({ canonicalId: "not-a-canonical", windowMinutes: 10 }), null);
});

// Every client builds the body with purgeRequest() and the route reads it with parsePurgeRequest():
// no hand-written purge body anywhere.
test("every purge caller goes through the shared request type", () => {
  const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const route = read("../../api/mod/purge/route.ts");
  assert.match(route, /parsePurgeRequest\(body\)/, "the route reads the shared shape");
  for (const rel of ["./run.ts", "../modQuickActions.ts", "../../components/UserCard.tsx", "../../features/moderation/sections/PurgeSection.tsx"]) {
    const src = read(rel);
    const at = src.indexOf('"/api/mod/purge"');
    assert.ok(at > 0, `${rel} posts to the purge route`);
    assert.match(src.slice(at, at + 160), /purgeRequest\(/, `${rel} builds its body with purgeRequest()`);
  }
  assert.match(route, /return Response\.json\(\{ ok: true, batchId, purged: items\.length \}\);\s*\}\s*$/, "vacuity anchor: the route was read to its end");
});
