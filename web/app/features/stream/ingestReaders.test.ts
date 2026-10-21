// The Stream tab's chat readers from the ingest's health answer:
// `{ ok, readers: { <platform>: { state, since, error } }, bot }`. Each state is read as itself, a
// failed reader's reason is one short line, and a shape the page does not know is "unknown".
// Run: node --test app/features/stream/ingestReaders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readersView } from "./ingestReaders.ts";

const since = "2026-10-20T08:00:00.000Z";
const health = {
  ok: false,
  readers: {
    kick: { state: "failed", since, error: "Chromium could not start: libnss3.so missing\n    at launch (browser.js:12)" },
    twitch: { state: "running", since },
    youtube: { state: "starting", since },
    streamplace: { state: "off", since },
  },
  bot: "running",
};

test("every reader state is read as itself, in the tab's platform order, with the bot's state", () => {
  const v = readersView({ reachable: true, health });
  assert.equal(v.kind, "ok");
  if (v.kind !== "ok") return;
  assert.equal(v.ok, false);
  assert.equal(v.bot, "running");
  assert.deepEqual(v.rows.map((r) => [r.platform, r.state]), [["twitch", "running"], ["youtube", "starting"], ["kick", "failed"], ["streamplace", "off"]]);
  assert.ok(v.rows.every((r) => r.since === since));
});

test("a failed reader's reason is its first line only, capped; a running one carries none", () => {
  const v = readersView({ reachable: true, health });
  if (v.kind !== "ok") throw new Error("vacuity: not read");
  assert.equal(v.rows.find((r) => r.platform === "kick")!.error, "Chromium could not start: libnss3.so missing");
  assert.equal(v.rows.find((r) => r.platform === "twitch")!.error, null);
  const long = readersView({ reachable: true, health: { ok: false, readers: { kick: { state: "failed", since, error: "x".repeat(500) } } } });
  if (long.kind !== "ok") throw new Error("vacuity");
  assert.equal(long.rows[0]!.error!.length, 240);
  assert.ok(long.rows[0]!.error!.endsWith("…"));
  const none = readersView({ reachable: true, health: { ok: false, readers: { kick: { state: "failed", since } } } });
  assert.equal(none.kind === "ok" && none.rows[0]!.error, null, "a failure with no reason is null — the section words it");
});

test("the ingest not answering is its own state, not 'no readers'", () => {
  assert.deepEqual(readersView({ reachable: false }), { kind: "unreachable" });
  assert.deepEqual(readersView(null), { kind: "unknown" });
});

test("a shape the page does not know is unknown; an unknown state or a bad date is dropped, never guessed", () => {
  for (const h of [null, "ok", { ok: true }, { ok: true, readers: [] }]) assert.deepEqual(readersView({ reachable: true, health: h }), { kind: "unknown" }, JSON.stringify(h));
  const v = readersView({ reachable: true, health: { ok: true, readers: { twitch: { state: "dancing" }, kick: { state: "running", since: "not a date" }, zzz: { state: "running" } }, bot: "maybe" } });
  if (v.kind !== "ok") throw new Error("vacuity");
  assert.deepEqual(v.rows.map((r) => r.platform), ["kick", "zzz"], "an unknown platform still shows, after the known ones");
  assert.equal(v.rows[0]!.since, null);
  assert.equal(v.bot, null);
  assert.equal(v.ok, true);
});
