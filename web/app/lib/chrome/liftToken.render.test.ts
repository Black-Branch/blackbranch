// A chrome token that moves the window ceiling (`--pane-chrome-above`, the chat tab bar's
// fold) is written with the SAME before/after lift announcement as the keyboard's K, so the window's
// lift-follow eases it — but only while the keyboard is up (with K = 0 the ceiling is 0 regardless).
//
// Run: node --test app/lib/chrome/liftToken.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../testDom.ts";
import { stripComments } from "../testSource.ts";
import "../testTsx.ts";

const { useLiftToken } = await import("./liftToken.ts");
const { KB_LIFT_EVENT } = await import("../useViewportHeightVar.ts");
const { createRoot } = await import("react-dom/client");

function Probe({ value }: { value: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useLiftToken(ref, "--pane-chrome-above", value);
  return React.createElement("div", { ref, id: "probe" });
}

test("first write is silent; a change is announced before and after the write — only with the keyboard up", () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const heard: string[] = [];
  const onLift = (e: Event) => {
    const d = (e as CustomEvent<{ phase: string }>).detail;
    const el = e.target as HTMLElement;
    heard.push(`${d.phase}:${el.style.getPropertyValue("--pane-chrome-above")}`);
  };
  dom.window.document.addEventListener(KB_LIFT_EVENT, onLift);
  act(() => root.render(React.createElement(Probe, { value: "var(--chrome-top-h)" })));
  const el = dom.window.document.getElementById("probe")!;
  assert.equal(el.style.getPropertyValue("--pane-chrome-above"), "var(--chrome-top-h)");
  assert.deepEqual(heard, [], "the first write moves nothing that was laid out");
  act(() => root.render(React.createElement(Probe, { value: "0px" })));
  assert.equal(el.style.getPropertyValue("--pane-chrome-above"), "0px");
  assert.deepEqual(heard, [], "keyboard down: the ceiling is 0 whatever the bar does — no announcement");
  dom.window.document.documentElement.classList.add("kb-open");
  act(() => root.render(React.createElement(Probe, { value: "var(--chrome-top-h)" })));
  assert.deepEqual(heard, ["before:0px", "after:var(--chrome-top-h)"], "keyboard up: the lift-follow reads its box on both sides of the write");
  act(() => root.render(React.createElement(Probe, { value: "var(--chrome-top-h)" })));
  assert.equal(heard.length, 2, "no change, no announcement");
  dom.window.document.documentElement.classList.remove("kb-open");
  dom.window.document.removeEventListener(KB_LIFT_EVENT, onLift);
  act(() => root.unmount());
  host.remove();
});

test("the chat column writes its chrome-above token through it, and its bar-reveal stands down under a top window", () => {
  const side = stripComments(readFileSync("app/features/chat/ChatSidebar.tsx", "utf8"));
  assert.match(side, /useLiftToken\(asideRef, "--pane-chrome-above", mobileCompactHidden \|\| compactOverlay \|\| composerReplaced \? "0px" : "var\(--chrome-top-h\)"\);/);
  assert.doesNotMatch(side, /"--pane-chrome-above":/, "not ALSO as an inline style: React would write it unannounced");
  assert.match(side, /const reveal = \(\) => \{ if \(topWindowUnderKeyboard\(el\)\) return;/, "every reveal path (swipe, scroll-up, hover) goes through reveal()");
});
