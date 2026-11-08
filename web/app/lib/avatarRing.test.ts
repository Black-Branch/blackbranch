// #233 "pfp outline is off-center and/or does not scale correctly": the platform ring around a
// live chat avatar (Chat rows › Avatars › Platform ring).
//
// The defect: the ring was an OUTER box-shadow on a picture whose size is fractional (21.63px ×
// the slider). Firefox snaps a box-shadow to whole device pixels but draws the picture at its
// fractional place, so the 1px ring came out thicker on one side than the other — measured on the
// reporter's own settings (1px ring, Avatar size 1.4×) in Firefox at 1× zoom: left 0.66, right
// 0.54, top 1.00, bottom 1.00 of a pixel. Its width was a fixed px while the picture scaled, and
// it sat OUTSIDE the box, so a right-margin term had to make room for it on one side only.
//
// Now: one rule draws the ring INSIDE the picture's own box (an outline inset by exactly its
// width) on a box snapped to whole pixels, and the width is × the same slider as the picture.
// Real-browser execution (Chromium + Firefox, 1× and 2×, sizes 1×/1.4×/2×): every side within
// 0.05px of the others — the look script in the report.
//
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/lib/avatarRing.test.ts
import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "./testDom.ts";
import { stripCssComments } from "./testSource.ts";
import { installResizeObserverStub, installRafStub } from "./testTsx.ts";

installResizeObserverStub();
installRafStub();
for (const k of ["HTMLElement", "Node", "Element"] as const) {
  (globalThis as Record<string, unknown>)[k] ??= dom.window[k];
}
const { default: ChatMessage } = await import("../features/chat/ChatMessage.tsx");
const { applyEffect, DEFAULTS } = await import("./settingsRegistry.ts");
const { createRoot } = await import("react-dom/client");

const css = stripCssComments(readFileSync(new URL("../globals.css", import.meta.url), "utf8"));
const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
const html = dom.window.document.documentElement;

type Props = Parameters<typeof ChatMessage>[0];
type Msg = Props["msg"];
const line = (id: number, extra: Partial<Msg> = {}) =>
  ({ id, platform: "twitch", username: "Robin", message: "hello", ts: id, ...extra }) as unknown as Msg;

async function pfpOf(msg: Msg) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ChatMessage, { emotes: {}, msg })); });
  const slot = host.querySelector(".chat-pfp") as HTMLElement;
  assert.ok(slot, "the row has its avatar slot");
  return { slot, pic: slot.firstElementChild as HTMLElement, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

const ringRule = () => /\.chat-pfp-ring-on \.chat-pfp-ring-el \{([^}]*)\}/.exec(css)?.[1] ?? "";

// ── The defect, reproduced at the source ─────────────────────────────────────

test("the ring is drawn on the picture's own box, inset by exactly its width (concentric by construction)", () => {
  const rule = ringRule();
  assert.ok(rule, "one rule draws the ring");
  assert.match(rule, /outline: var\(--avatar-ring-w\) solid var\(--ring-c\);/);
  assert.match(rule, /outline-offset: calc\(-1 \* var\(--avatar-ring-w\)\);/,
    "the ring's outer edge is the picture's edge and its inner edge is its width in — the same centre at every size");
});

test("the ring's width follows the picture's size: × the same Avatar-size slider, whole pixels, never under 1px", () => {
  assert.match(ringRule(), /--avatar-ring-w: max\(1px, round\(calc\(var\(--chat-pfp-ring-w, 2px\) \* var\(--chat-pfp-scale, 1\)\), 1px\)\);/);
});

for (const [what, msg] of [["a picture", line(1, { avatarUrl: "https://cdn.example.tv/a.png" } as Partial<Msg>)], ["a letter (no picture)", line(2)]] as const) {
  test(`${what}: the live chat avatar is a scale step × the slider, wears the ring, and carries no outer shadow`, async () => {
    const m = await pfpOf(msg);
    assert.ok(m.pic.classList.contains("avatar"), "the picture is sized by the one scale");
    assert.ok(m.pic.classList.contains("chat-pfp-ring-el"), "the picture is what the ring rule draws on");
    assert.equal(m.pic.style.getPropertyValue("--avatar-size"), "calc(var(--avatar-line) * var(--chat-pfp-scale, 1))");
    assert.equal(m.pic.style.boxShadow, "", "no outer box-shadow ring (the off-centre one)");
    assert.doesNotMatch(m.pic.getAttribute("style") ?? "", /(^|;\s*)(width|height):/, "the box comes from the scale's class, not inline");
    // The ring takes no room, so both sides of the slot are the row's own gaps — no one-sided ring term.
    assert.equal(m.slot.style.marginRight, "var(--chat-pi-gap, 11px)");
    await m.unmount();
  });
}

test("vacuity: the ring rule sits after the .avatar rule it draws on, and the old ring variable is gone", () => {
  const avatarAt = css.indexOf(".avatar {");
  const ringAt = css.indexOf(".chat-pfp-ring-on .chat-pfp-ring-el {");
  assert.ok(avatarAt > 0 && ringAt > avatarAt, `.avatar at ${avatarAt}, the ring at ${ringAt}`);
  assert.doesNotMatch(css, /--chat-pfp-ring:/, "the outer-ring variable (and its margin term) is retired");
});

// ── Restart and retry ────────────────────────────────────────────────────────

test("restart: the prepaint script restores exactly what the ring rule reads (ring mode + its width)", () => {
  assert.match(layout, /localStorage\.getItem\('chatStyle_pfpRing'\) === '1'\) document\.documentElement\.classList\.add\('chat-pfp-ring-on'\)/);
  assert.match(layout, /setProperty\('--chat-pfp-ring-w', _prw \+ 'px'\)/);
  assert.match(layout, /setProperty\('--chat-pfp-scale', String\(_psc\)\)/);
  // …and the ring reads those names, not another spelling.
  assert.match(ringRule(), /var\(--chat-pfp-ring-w, 2px\)/);
  assert.match(ringRule(), /var\(--chat-pfp-scale, 1\)/);
});

test("retry: ring off then on again draws the same ring at the new width", () => {
  const ctx = { get: <K extends keyof typeof DEFAULTS>(k: K) => DEFAULTS[k] };
  applyEffect("pfpRing", true, ctx);
  applyEffect("pfpRingWidth", 3, ctx);
  assert.ok(html.classList.contains("chat-pfp-ring-on"));
  assert.equal(html.style.getPropertyValue("--chat-pfp-ring-w"), "3px");
  applyEffect("pfpRing", false, ctx);
  assert.ok(!html.classList.contains("chat-pfp-ring-on"), "off: the rule no longer matches, so no ring paints");
  applyEffect("pfpRingWidth", 1, ctx);
  applyEffect("pfpRing", true, ctx);
  assert.ok(html.classList.contains("chat-pfp-ring-on"), "on again");
  assert.equal(html.style.getPropertyValue("--chat-pfp-ring-w"), "1px", "the width the ring reads is the last one chosen");
  applyEffect("pfpRing", false, ctx);
});
