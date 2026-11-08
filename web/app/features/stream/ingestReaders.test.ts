// The Stream tab's chat readers from the ingest's health answer:
// `{ ok, readers: { <platform>: { state, since, error } }, bot }`. Each state is read as itself, a
// failed reader's reason is one short line, and a shape the page does not know is "unknown".
// Run: node --test app/features/stream/ingestReaders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readersView, livenessChip, YOUTUBE_LIVE_NOTE } from "./ingestReaders.ts";
import { PLATFORM_LIVENESS } from "../../lib/platformLiveness.generated.mjs";
import { mergePlatformRows } from "./platformsView.ts";
import type { PlatformRow } from "../../lib/streamStats.ts";

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

// ── Per-platform liveness (Task 10): the ingest's `liveness`, as chips on each row ─────────────────
// `{ <platform>: { state, since, lastAnswerAt, scheduledStart, evidence, misses, stale } | null }`.
// Words come from the vocabulary (EVIDENCE); a code it does not know reads "Can't tell", never a guess.
const live = (state: string, o: Record<string, unknown> = {}) => ({ state, since, lastAnswerAt: since, scheduledStart: null, evidence: "", misses: 0, stale: false, ...o });
const fmt = (iso: string) => `at ${iso}`;

test("chip words: Live, Offline, Scheduled for <local time>, and Can't tell with the vocabulary's words — one code of each platform", () => {
  assert.equal(livenessChip(live("live", { evidence: "helix-live" }), fmt).words, "Live");
  assert.equal(livenessChip(live("offline", { evidence: "kick-not-live" }), fmt).words, "Offline");
  assert.equal(livenessChip(live("upcoming", { evidence: "upcoming", scheduledStart: "2026-10-25T18:00:00.000Z" }), fmt).words, "Scheduled for at 2026-10-25T18:00:00.000Z");
  assert.equal(livenessChip(live("upcoming", { evidence: "upcoming" }), fmt).words, "Scheduled", "no start known");
  for (const code of ["helix-error", "kick-error", "unrecognized-page", "socket-quiet"]) {
    const chip = livenessChip(live("unknown", { evidence: code }), fmt);
    assert.equal(chip.words, `Can't tell — ${PLATFORM_LIVENESS.EVIDENCE[code as keyof typeof PLATFORM_LIVENESS.EVIDENCE]}`, code);
    assert.equal(chip.state, "unknown");
  }
  assert.equal(livenessChip(live("unknown", { evidence: "helix-error" }), fmt).words, "Can't tell — Twitch could not be asked, or its answer could not be read", "vacuity: real words");
  assert.equal(livenessChip(live("unknown", { evidence: "a-code-from-a-newer-ingest" }), fmt).words, "Can't tell");
  // The chip's head and the reason line (#247): the whole words are exactly head — why.
  const why = livenessChip(live("unknown", { evidence: "helix-error" }), fmt);
  assert.deepEqual([why.head, why.why], ["Can't tell", "Twitch could not be asked, or its answer could not be read"]);
  assert.equal(why.words, `${why.head} — ${why.why}`);
  const lv = livenessChip(live("live", { evidence: "helix-live" }), fmt);
  assert.deepEqual([lv.head, lv.why], ["Live", null], "only a can't-tell carries a reason");
  assert.equal(livenessChip(live("upcoming", { scheduledStart: "2026-10-25T18:00:00.000Z" }), fmt).head, "Scheduled for at 2026-10-25T18:00:00.000Z");
  assert.equal(livenessChip(live("unknown", { evidence: "a-code-from-a-newer-ingest" }), fmt).why, null);
  assert.equal(livenessChip(live("unknown", { evidence: "__proto__" }), fmt).words, "Can't tell", "a prototype name is not a code");
  assert.equal(livenessChip(live("dancing"), fmt).state, "unknown", "a state the page does not know reads can't tell");
  const stale = livenessChip(live("unknown", { evidence: "helix-error", stale: true }), fmt);
  assert.equal(stale.stale, true);
  assert.match(stale.note ?? "", /^No answer for over 15 min/);
  assert.equal(livenessChip(live("live"), fmt).note, null);
});

test("readersView carries each configured platform's chip on its row; not configured is none; an older ingest has none", () => {
  const v = readersView({ reachable: true, health: { ...health, liveness: { twitch: live("live", { evidence: "helix-live" }), youtube: live("unknown", { evidence: "unrecognized-page" }), kick: null, streamplace: "bad" } } });
  if (v.kind !== "ok") throw new Error("vacuity: not read");
  const by = Object.fromEntries(v.rows.map((r) => [r.platform, r.live?.words ?? null]));
  assert.deepEqual(by, { twitch: "Live", youtube: "Can't tell — YouTube showed a consent or bot-check page", kick: null, streamplace: null });
  const older = readersView({ reachable: true, health });
  if (older.kind !== "ok") throw new Error("vacuity");
  assert.ok(older.rows.every((r) => r.live === null));
  // A platform with live detection but no reader row still shows.
  const only = readersView({ reachable: true, health: { ok: true, readers: {}, liveness: { kick: live("offline") } } });
  if (only.kind !== "ok") throw new Error("vacuity");
  assert.deepEqual(only.rows.map((r) => [r.platform, r.state, r.live?.words]), [["kick", null, "Offline"]]);
});

test("the YouTube row note says when YouTube ends a broadcast by itself", () => {
  assert.equal(YOUTUBE_LIVE_NOTE, "YouTube ends the broadcast about a minute after you stop only when auto-stop is on in YouTube Studio; otherwise it stays live until you end it there.");
});

// ── #247: the one Platforms card joins the site's rows and the readers' rows ───────────────────────
const siteRow = (key: PlatformRow["key"], label: string): PlatformRow => ({ key, label, setUp: true, embed: null, title: null, category: null, titleNote: "", manageUrl: null, setupHref: `/admin/platforms?sub=${key}` });

test("merge: one row per platform — the site's order, each with its reader; a reader-only platform after; nothing dropped", () => {
  const v = readersView({ reachable: true, health: { ...health, readers: { ...health.readers, zzz: { state: "running", since } } } });
  if (v.kind !== "ok") throw new Error("vacuity: not read");
  const site = [siteRow("twitch", "Twitch"), siteRow("youtube", "YouTube"), siteRow("native", "Site player"), siteRow("kick", "Kick")];
  const rows = mergePlatformRows(site, v.rows);
  assert.deepEqual(rows.map((r) => [r.key, r.site?.label ?? null, r.reader?.state ?? null]), [
    ["twitch", "Twitch", "running"], ["youtube", "YouTube", "starting"], ["native", "Site player", null], ["kick", "Kick", "failed"],
    ["streamplace", null, "off"], ["zzz", null, "running"],
  ]);
  assert.equal(rows.find((r) => r.key === "streamplace")!.label, "Streamplace", "a reader-only row is named by the platform vocabulary");
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "no platform twice");
});

test("merge: the site not loaded yet still shows the readers; the readers not answering still shows the site", () => {
  const v = readersView({ reachable: true, health });
  if (v.kind !== "ok") throw new Error("vacuity");
  assert.deepEqual(mergePlatformRows(null, v.rows).map((r) => r.key), ["twitch", "youtube", "kick", "streamplace"]);
  assert.deepEqual(mergePlatformRows([siteRow("twitch", "Twitch")], []).map((r) => [r.key, r.reader]), [["twitch", null]]);
  assert.deepEqual(mergePlatformRows(null, []), []);
});
