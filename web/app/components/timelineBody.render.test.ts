// One loading state for a message area (client polish Task 11 Step 1b; dm-crypto-research D,
// k's item 12): opening a DM ran five message-area states in 235 ms with three layout shifts.
// TimelineBody is the ONE component that draws the area for the community timeline and the DM
// window: exactly one of {skeleton, "No messages yet", rows} shows, and the top slot ("Loading
// earlier messages…" / "Beginning of conversation") is one box of one height whatever it says.
// While loading the rows are laid out UNDER the skeleton (invisible), so the auto-fill measures
// them and the first row is already where it will be when the skeleton goes.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/timelineBody.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../lib/testDom.ts";
import { stripComments } from "../lib/testSource.ts";
import "../lib/testTsx.ts";

const { TimelineBody } = await import("./TimelineBody.tsx");
const { EncryptionBanner } = await import("./EncryptionBanner.tsx");
const { createRoot } = await import("react-dom/client");

async function mount(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return {
    host,
    q: (s: string) => host.querySelector(s) as HTMLElement | null,
    rerender: (next: React.ReactElement) => act(async () => { root.render(next); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => React.createElement("p", { key: i, "data-row": "" }, `line ${i}`));
const body = (p: Partial<{ phase: "loading" | "ready"; count: number; hitStart: boolean; paginating: boolean; topSlot: React.ReactNode }>) => {
  const count = p.count ?? 0;
  return React.createElement(TimelineBody, {
    phase: p.phase ?? "ready", count, hitStart: p.hitStart ?? false, paginating: p.paginating ?? false,
    emptyText: "No messages yet.",
    rows: rows(count),
    topSlot: p.topSlot,
  });
};
const shown = (el: HTMLElement | null) => !!el && !el.closest("[aria-hidden='true']") && !el.className.includes("invisible");

test("phase loading → only the skeleton", async () => {
  const m = await mount(body({ phase: "loading", count: 3 }));
  const skeleton = m.q("[data-timeline-skeleton]");
  assert.ok(skeleton, "the skeleton is drawn");
  assert.equal(skeleton!.querySelectorAll("[data-skeleton-row]").length, 4, "four grey rows");
  assert.equal(skeleton!.getAttribute("aria-hidden"), "true", "a screen reader hears nothing of it");
  const list = m.q("[data-timeline-rows]")!;
  assert.equal(list.querySelectorAll("[data-row]").length, 3, "the rows are laid out under it, so the fill can measure them");
  assert.ok(list.className.includes("invisible") && list.getAttribute("aria-hidden") === "true", "…but not shown");
  assert.doesNotMatch(m.host.textContent ?? "", /No messages yet/);
  assert.equal(m.q("[data-timeline-top]")!.textContent, "", "the top slot says nothing while loading");
  await m.unmount();
});

test("ready + 0 rows + hitStart → only 'No messages yet'", async () => {
  const m = await mount(body({ phase: "ready", count: 0, hitStart: true }));
  assert.ok(m.q("[data-timeline-skeleton]") === null);
  assert.match(m.host.textContent ?? "", /No messages yet\./);
  assert.equal(m.q("[data-timeline-top]")!.textContent, "", "an empty room has no 'Beginning of conversation' over nothing");
  await m.unmount();
  // Loading that stopped before the beginning was known (the 3 s ceiling, a failed page — an empty
  // DM opened offline): still the empty copy, never a blank area.
  const n = await mount(body({ phase: "ready", count: 0, hitStart: false }));
  assert.match(n.host.textContent ?? "", /No messages yet\./);
  assert.equal(n.q("[data-timeline-top]")!.textContent, "");
  await n.unmount();
});

test("ready + rows → rows, no skeleton, no empty copy", async () => {
  const m = await mount(body({ phase: "ready", count: 2, hitStart: true }));
  assert.ok(m.q("[data-timeline-skeleton]") === null);
  const list = m.q("[data-timeline-rows]")!;
  assert.ok(shown(list), "the rows show");
  assert.equal(list.querySelectorAll("[data-row]").length, 2);
  assert.doesNotMatch(m.host.textContent ?? "", /No messages yet/);
  await m.unmount();
});

test("the caller's top slot (an earlier conversation) shows at the start of the room, in place of 'Beginning of conversation' — never before it", async () => {
  const earlier = React.createElement("button", { "data-earlier": "" }, "Earlier conversation");
  const m = await mount(body({ phase: "ready", count: 2, hitStart: false, topSlot: earlier }));
  assert.equal(m.q("[data-earlier]"), null, "not at the start yet: older lines of THIS room come first");
  await m.rerender(body({ phase: "ready", count: 2, hitStart: true, topSlot: earlier }));
  assert.ok(m.q("[data-timeline-top] [data-earlier]"), "at the start: the earlier room is what comes before");
  assert.doesNotMatch(m.q("[data-timeline-top]")!.textContent ?? "", /Beginning of conversation/);
  await m.rerender(body({ phase: "ready", count: 0, hitStart: true, topSlot: earlier }));
  assert.ok(m.q("[data-timeline-top] [data-earlier]"), "a room with no line of its own still leads back to the earlier one");
  await m.rerender(body({ phase: "ready", count: 2, paginating: true, hitStart: true, topSlot: earlier }));
  assert.equal(m.q("[data-timeline-top]")!.textContent, "Loading earlier messages…");
  await m.unmount();
});

test("the top slot keeps one height whether it shows 'Loading earlier messages…' or 'Beginning of conversation'", async () => {
  const m = await mount(body({ phase: "ready", count: 2, paginating: true }));
  const slot = m.q("[data-timeline-top]")!;
  assert.equal(slot.textContent, "Loading earlier messages…");
  const cls = slot.className;
  await m.rerender(body({ phase: "ready", count: 2, hitStart: true }));
  const after = m.q("[data-timeline-top]")!;
  assert.ok(after === slot, "the same box");
  assert.equal(after.textContent, "Beginning of conversation");
  assert.equal(after.className, cls, "the same classes, so the same height");
  assert.match(cls, /(^|\s)h-6(\s|$)/, "a fixed height, never its text's");
  await m.rerender(body({ phase: "ready", count: 2 }));
  const emptied = m.q("[data-timeline-top]");
  assert.ok(emptied === slot, "the same box, still holding its height");
  assert.equal(emptied.textContent, "", "empty");
  await m.unmount();
});

test("EncryptionBanner's box is present from the first render", async () => {
  // The app-wide verdict is read synchronously (the remembered one before Matrix has checked): a
  // device known to be unverified has the line in its FIRST render, never a late insertion.
  const red = await mount(React.createElement(EncryptionBanner, { encrypted: true, verdict: "red", onEnable: async () => {} }));
  assert.match(red.q("[data-encryption-banner]")?.textContent ?? "", /Session unverified/, "in the first render");
  await red.unmount();
  // Nothing to say — and no empty box held — for: a verified device; "yellow" (THIS device is
  // verified, another of the account's is not: Devices & Security's business, not a DM's); and an
  // unknown verdict (an empty reserved box would collapse under the messages when "green" lands).
  for (const verdict of ["green", "yellow", null] as const) {
    const m = await mount(React.createElement(EncryptionBanner, { encrypted: true, verdict, onEnable: async () => {} }));
    assert.ok(m.q("[data-encryption-banner]") === null, `${verdict}: nothing`);
    assert.equal(m.host.childElementCount, 0, `${verdict}: no box at all`);
    await m.unmount();
  }
  const plain = await mount(React.createElement(EncryptionBanner, { encrypted: false, verdict: "green", onEnable: async () => {} }));
  assert.match(plain.q("[data-encryption-banner]")?.textContent ?? "", /Not encrypted/);
  await plain.unmount();
  // The community timeline passes the app-wide verdict (useEncryptionStatus), never a check of its own.
  const tl = stripComments(readFileSync(new URL("../features/community/Timeline.tsx", import.meta.url), "utf8"));
  assert.match(tl, /const \{ verdict: encryptionVerdict \} = useEncryptionStatus\(\);/);
  assert.match(tl, /<EncryptionBanner encrypted=\{encrypted\} verdict=\{encryptionVerdict\}/);
  assert.doesNotMatch(tl, /getDeviceVerificationStatus/, "no second, late verdict");
  assert.match(tl, /\}\s*$/, "vacuity anchor: the read reached the end of the file");
});

test("both message areas draw through TimelineBody", () => {
  for (const f of ["../features/community/Timeline.tsx", "../features/dm/DmConversation.tsx"]) {
    const src = stripComments(readFileSync(new URL(f, import.meta.url), "utf8"));
    assert.match(src, /<TimelineBody\b/, `${f} renders its area through TimelineBody`);
    assert.doesNotMatch(src, /<EmptyState/, `${f} has no empty state of its own`);
    assert.doesNotMatch(src, /Loading earlier messages|Beginning of conversation/, `${f} has no top-slot copy of its own`);
    assert.match(src, /\}\s*$/, `vacuity anchor: ${f} was read to the end`);
  }
});
