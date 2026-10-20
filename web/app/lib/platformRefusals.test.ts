// The per-tab refusal store (U1 rework), RUN through its hooks: what a
// persistent refusal and a transient failure each leave behind — the note, the
// skip list, the Send-to menu's state.
//
// Run: node --test app/lib/platformRefusals.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "./testDom.ts";

await import("./testTsx.ts");
const {
  recordFailures, skippedPlatforms, retryDestination, dismissRefusalNote,
  useRefusalNote, useSkippedPlatforms, resetRefusals, TRANSIENT_WINDOW_MS,
} = await import("./platformRefusals.ts");

test.beforeEach(() => resetRefusals());

const followers = { platform: "kick", error: "refused", reason: "followers-only" };
const notLive = { platform: "twitch", error: "not_live" };

/** The composer's view of the store: the note and the menu's skip map, re-rendered per change. */
async function view() {
  return mountHook(() => ({ note: useRefusalNote(), skips: useSkippedPlatforms() }));
}

/** Read through a function: after `assert.equal(note, null)` TypeScript narrows the property to `null` for good. */
function noteText(v: { current: { note: { text: string } | null } }): string | undefined {
  return v.current.note?.text;
}

test("a persistent refusal: one note, the platform skipped, nothing to mark on the line", async () => {
  const v = await view();
  let out: { marked: string[] } = { marked: ["unset"] };
  await v.act(() => { out = recordFailures([followers], 1_000); });
  assert.deepEqual(out.marked, [], "a persistent refusal is explained by the note, not on the line");
  assert.deepEqual(skippedPlatforms(), ["kick"]);
  assert.equal(v.current.note?.kind, "persistent");
  assert.equal(v.current.note?.platform, "kick");
  assert.equal(v.current.note?.text, "Kick is followers-only. Follow on Kick to post there, or change Send to.");
  assert.deepEqual(v.current.note?.forms, ["Kick is followers-only. Follow on Kick to post there, or change Send to.", "Kick is followers-only — tap Send to", "Follow on Kick"],
    "longest first; the composer shows the longest that fits");
  await v.unmount();
});

test("a transient note has a short form too", async () => {
  const v = await view();
  await v.act(() => { recordFailures([notLive, { platform: "kick", error: "send_failed" }], 1_000); });
  assert.deepEqual(v.current.note?.forms, ["Posted here — Twitch isn't live; couldn't reach Kick.", "Missed Twitch, Kick"]);
  await v.unmount();
});

test("the same platform+reason is explained once per session — a dismissed note stays dismissed", async () => {
  const v = await view();
  await v.act(() => { recordFailures([followers], 1_000); });
  await v.act(() => dismissRefusalNote());
  assert.equal(v.current.note, null);
  await v.act(() => { recordFailures([followers], 2_000); });
  assert.equal(v.current.note, null, "the second identical refusal does not bring the note back");
  // A different reason on the same platform IS new information.
  await v.act(() => { recordFailures([{ platform: "kick", error: "refused", reason: "you're banned there" }], 3_000); });
  assert.equal(noteText(v), "You're banned on Kick, so your messages post here only. Change Send to to stop trying Kick.");
  await v.unmount();
});

test("the Send-to menu reads each skipped platform's state", async () => {
  const v = await view();
  assert.equal(v.current.skips.size, 0);
  await v.act(() => { recordFailures([followers], 1_000); });
  assert.equal(v.current.skips.get("kick"), "followers-only");
  await v.unmount();
});

test("re-selecting the platform clears its skip (and its note); picking All clears every skip", async () => {
  const v = await view();
  await v.act(() => { recordFailures([followers, { platform: "twitch", error: "refused", reason: "subscribers-only" }], 1_000); });
  assert.deepEqual(skippedPlatforms().sort(), ["kick", "twitch"]);
  await v.act(() => retryDestination("twitch"));
  assert.deepEqual(skippedPlatforms(), ["kick"]);
  assert.equal(v.current.skips.has("twitch"), false, "the menu stops showing the state");
  await v.act(() => retryDestination(null));
  assert.deepEqual(skippedPlatforms(), ["kick"], "the site holds no skip to clear");
  await v.act(() => retryDestination("all"));
  assert.deepEqual(skippedPlatforms(), []);
  assert.equal(v.current.note, null, "a retried platform's note goes with its skip");
  await v.unmount();
});

test("a transient failure: shown at most once per platform per window, every such line marked", async () => {
  const v = await view();
  const notes = new Set<number>();
  for (let i = 0; i < 10; i++) {
    let out: { marked: string[] } = { marked: [] };
    await v.act(() => { out = recordFailures([notLive], 1_000 + i * 1_000); });
    assert.deepEqual(out.marked, ["twitch"], "each line that missed a platform carries the zero-height marker");
    if (v.current.note) notes.add(v.current.note.id);
  }
  assert.equal(notes.size, 1, "ten failures inside the window show ONE note");
  assert.equal(v.current.note?.kind, "transient");
  assert.equal(v.current.note?.text, "Posted here — Twitch isn't live.");
  assert.deepEqual(skippedPlatforms(), [], "a transient failure never skips the platform");
  await v.act(() => dismissRefusalNote());
  await v.act(() => { recordFailures([notLive], 1_000 + TRANSIENT_WINDOW_MS - 1); });
  assert.equal(v.current.note, null, "still inside the window: quiet");
  await v.act(() => { recordFailures([notLive], 1_000 + TRANSIENT_WINDOW_MS); });
  assert.equal(noteText(v), "Posted here — Twitch isn't live.", "past the window it shows again");
  await v.unmount();
});

test("a transient failure never replaces an unread persistent note (one note at a time)", async () => {
  const v = await view();
  await v.act(() => { recordFailures([followers], 1_000); });
  await v.act(() => { recordFailures([notLive], 2_000); });
  assert.equal(v.current.note?.kind, "persistent");
  // ...and its window was not spent while it could not be seen.
  await v.act(() => dismissRefusalNote());
  await v.act(() => { recordFailures([notLive], 3_000); });
  assert.equal(v.current.note?.kind, "transient");
  await v.unmount();
});

test("dismissing by id leaves a newer note alone", async () => {
  const v = await view();
  await v.act(() => { recordFailures([notLive], 1_000); });
  const first = v.current.note!;
  await v.act(() => dismissRefusalNote());
  await v.act(() => { recordFailures([{ platform: "kick", error: "send_failed" }], 2_000); });
  await v.act(() => dismissRefusalNote(first.id));
  assert.equal(v.current.note?.platform, "kick", "a stale timer for the first note must not close the second");
  await v.unmount();
});

// ── Infrastructure (ticket #184) ─────────────────────────────────────────────
// Not viewer-actionable: silent unless the viewer picked that platform ALONE,
// and then ONE plain line per platform per session.

const ytQuota = { platform: "youtube", error: "unavailable", reason: "quota" };
const YT_LINE = "Couldn't reach YouTube chat right now.";

test("infrastructure, line went to several platforms (alone = null): no note, no mark, no skip", async () => {
  const v = await view();
  let out: { marked: string[] } = { marked: ["unset"] };
  for (let i = 0; i < 5; i++) await v.act(() => { out = recordFailures([ytQuota], 1_000 + i, null); });
  assert.equal(v.current.note, null, "nothing in the composer");
  assert.deepEqual(out.marked, [], "no ⊘ on the line");
  assert.deepEqual(skippedPlatforms(), [], "the platform is not skipped — the next copy is tried");
  assert.equal(v.current.skips.size, 0, "the Send-to menu shows no state for it");
  await v.unmount();
});

test("infrastructure beside a transient and a persistent failure: those keep their own outcome", async () => {
  const v = await view();
  let out: { marked: string[] } = { marked: [] };
  await v.act(() => { out = recordFailures([ytQuota, notLive], 1_000, null); });
  assert.deepEqual(out.marked, ["twitch"], "only the transient one is marked");
  assert.equal(noteText(v), "Posted here — Twitch isn't live.", "the note names Twitch alone — YouTube's quota is not in it");
  await v.act(() => dismissRefusalNote());
  await v.act(() => { recordFailures([ytQuota, followers], 2_000, null); });
  assert.equal(noteText(v), "Kick is followers-only. Follow on Kick to post there, or change Send to.");
  assert.deepEqual(skippedPlatforms(), ["kick"]);
  await v.unmount();
});

test("infrastructure, YouTube picked alone: exactly one plain line, once per session, never skipped or marked", async () => {
  const v = await view();
  const notes = new Set<number>();
  for (let i = 0; i < 10; i++) {
    let out: { marked: string[] } = { marked: ["unset"] };
    await v.act(() => { out = recordFailures([ytQuota], 1_000 + i * TRANSIENT_WINDOW_MS, "youtube"); });
    assert.deepEqual(out.marked, [], "no ⊘ on the line");
    if (v.current.note) notes.add(v.current.note.id);
    if (i === 0) {
      assert.equal(v.current.note?.text, YT_LINE);
      assert.equal(v.current.note?.kind, "unavailable");
      assert.doesNotMatch(v.current.note!.forms.join(" "), /quota|limit|error|403/i, "no code, no mention of quotas");
      await v.act(() => dismissRefusalNote());
    }
  }
  assert.equal(notes.size, 1, "ten quota-outs across the night: one line, even past the transient window");
  assert.equal(v.current.note, null, "a dismissed line stays dismissed");
  assert.deepEqual(skippedPlatforms(), [], "re-sending to YouTube is allowed");
  await v.unmount();
});

test("infrastructure: the same wording for Twitch or Kick alone, each platform once", async () => {
  const v = await view();
  await v.act(() => { recordFailures([{ platform: "twitch", error: "unavailable", reason: "upstream" }], 1_000, "twitch"); });
  assert.equal(noteText(v), "Couldn't reach Twitch chat right now.");
  await v.act(() => { recordFailures([{ platform: "kick", error: "unavailable", reason: "timeout" }], 2_000, "kick"); });
  assert.equal(noteText(v), "Couldn't reach Kick chat right now.");
  await v.unmount();
});

test("infrastructure, alone, never replaces an unread persistent note — and is not spent while hidden", async () => {
  const v = await view();
  await v.act(() => { recordFailures([followers], 1_000); });
  await v.act(() => { recordFailures([ytQuota], 2_000, "youtube"); });
  assert.equal(v.current.note?.kind, "persistent");
  await v.act(() => dismissRefusalNote());
  await v.act(() => { recordFailures([ytQuota], 3_000, "youtube"); });
  assert.equal(noteText(v), YT_LINE, "shown once the persistent note is gone");
  await v.unmount();
});

test("RETRY: the same failed send again after the line does not show it again or replace it", async () => {
  const v = await view();
  await v.act(() => { recordFailures([ytQuota], 1_000, "youtube"); });
  const first = v.current.note!;
  await v.act(() => { recordFailures([ytQuota], 1_500, "youtube"); });
  assert.equal(v.current.note?.id, first.id, "the line on screen is the same one, not a second");
  await v.unmount();
});

test("RESTART: a fresh page load (a new module instance) shows the line again, at most once", async () => {
  // A reload is a new document: the store is module state, so a new instance IS the restart.
  for (const load of ["first", "second"]) {
    const fresh = await import(`./platformRefusals.ts?restart=${load}`) as typeof import("./platformRefusals.ts");
    const v = await mountHook(() => fresh.useRefusalNote());
    const ids = new Set<number>();
    for (let i = 0; i < 4; i++) {
      await v.act(() => { fresh.recordFailures([ytQuota], 1_000 + i, "youtube"); });
      if (v.current) ids.add(v.current.id);
    }
    assert.equal(ids.size, 1, `${load} load: the line once`);
    assert.equal(v.current?.text, YT_LINE);
    await v.unmount();
  }
});
