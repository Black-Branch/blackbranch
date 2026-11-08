// The Stream tab's Platforms rows (streamPlatformsServer.ts), built through the real settings reader
// with stub deps: Kick's row carries an embed switch like Twitch's and YouTube's (decision 0135 —
// every embed is a streamer toggle), on by default whenever a Kick slug is set.
// No network: with no app credentials and no Twitch/YouTube channel no title is fetched, and
// fetch is replaced so a stray call fails the test instead of reaching a platform.
// Run: node --test app/lib/streamPlatformsServer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "./testInstallValues.ts";
import { createInstanceReader } from "./instanceConfigServer.ts";

const quiet = { warn() {}, error() {}, log() {} };
const G = globalThis as typeof globalThis & { __instanceReader?: ReturnType<typeof createInstanceReader> };

/** Install a settings reader answering from `plain` (as site.instance_config would). */
async function settings(plain: Record<string, unknown>) {
  const r = createInstanceReader({
    env: () => ({}),
    queryPlain: async () => Object.entries(plain).map(([key, value]) => ({ key, value })),
    fetchSecrets: async () => ({ values: {} }),
    queryChainBuilt: async () => false,
    now: () => Date.now(),
    log: quiet,
  });
  assert.equal(await r.load(), true);
  G.__instanceReader = r;
}

globalThis.fetch = (async (u: unknown) => {
  throw new Error(`no network in this test: ${String(u)}`);
}) as typeof fetch;

const { platformRows } = await import("./streamPlatformsServer.ts");

test("the Stream tab's Kick row has an embed switch, on by default when a Kick slug is set", async () => {
  await settings({ "platform.kick.slug": "casey" });
  const kick = (await platformRows(null)).find((r) => r.key === "kick");
  assert.ok(kick, "a Kick row");
  assert.equal(kick.setUp, true);
  assert.deepEqual(kick.embed, { source: "kick", on: true });
});

test("Kick's switch off (player.embedsOff) reads off in its row; the others stay on", async () => {
  await settings({ "platform.kick.slug": "casey", "player.embedsOff": ["kick"] });
  const rows = await platformRows(null);
  assert.deepEqual(rows.find((r) => r.key === "kick")?.embed, { source: "kick", on: false });
  assert.deepEqual(rows.find((r) => r.key === "twitch")?.embed, { source: "twitch", on: true });
});

test("every row that is a player source carries its switch, in the tab's order", async () => {
  await settings({});
  const rows = await platformRows(null);
  assert.deepEqual(rows.map((r) => [r.key, r.embed?.source ?? null]), [
    ["twitch", "twitch"], ["youtube", "youtube"], ["kick", "kick"], ["streamplace", "streamplace"], ["native", "native"],
  ]);
  assert.equal(rows.find((r) => r.key === "kick")?.setUp, false, "no slug: Kick is not set up");
});
