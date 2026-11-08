// Thumb-sized bar buttons (client polish Task 5). Discord gives every header
// and toolbar icon about 44px of touch; ours were 23×20 (Timeline) and 26×26
// (BarButton) on a phone. `size="touch"` makes the BUTTON 40px wide and the
// bar's full height (36px) while the icon and its hover/on fill keep their size.
//
// jsdom has no layout, so this checks the CSS the box is built from (the real
// chrome.css, injected) and the wiring; the 40×36 measurement is the Look's
// (look/05-targets.mjs on the throwaway pair).
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/chrome/barButtonTouch.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../../lib/testDom.ts";
import { stripComments, stripCssComments, cssAtRuleBodies } from "../../lib/testSource.ts";
import "../../lib/testTsx.ts";

const { BarButton } = await import("./BarButton.tsx");
const { createRoot } = await import("react-dom/client");

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// jsdom applies no rule inside @layer or @media, so the layer's BODY is what
// goes in. The layer only orders chrome against Tailwind utilities; nothing
// in it competes with another rule of chrome.css.
const chromeCss = stripCssComments(read("./chrome.css"));
const layers = cssAtRuleBodies(chromeCss, "@layer components");
const style = dom.window.document.createElement("style");
style.textContent = layers.join("\n");
dom.window.document.head.appendChild(style);

type Props = Parameters<typeof BarButton>[0];
async function mount(props: Partial<Props> & { label: string }) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(BarButton, { icon: "x", onClick: () => {}, ...props })); });
  const btn = host.querySelector("button")!;
  return { btn, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

test("the stylesheet the boxes are read from is the real chrome.css, one layer, holding the bar button", () => {
  assert.equal(layers.length, 1, "chrome.css is ONE @layer components block — the unwrap above reads that block");
  assert.match(layers[0] ?? "", /\.chrome-bar-btn \{/);
});

test("a touch BarButton is 2.5rem wide and the bar's full height, and does not shrink", async () => {
  const m = await mount({ label: "Pinned messages", size: "touch" });
  const cs = dom.window.getComputedStyle(m.btn);
  assert.match(m.btn.className, /\bchrome-bar-btn\b/, "still the one bar-button class");
  assert.match(m.btn.className, /\bchrome-bar-btn--touch\b/);
  assert.equal(cs.width, "2.5rem");
  assert.equal(cs.height, "100%");
  // Six of them share a 390px header with the channel name: the name gives
  // way (truncate), never a button.
  assert.equal(cs.flexShrink, "0");
  await m.unmount();
});

test("a plain BarButton keeps its 26px box — the touch size is opt-in", async () => {
  const m = await mount({ label: "Close" });
  const cs = dom.window.getComputedStyle(m.btn);
  assert.doesNotMatch(m.btn.className, /--touch/);
  assert.equal(cs.height, "1.625rem");
  assert.equal(cs.minWidth, "1.625rem");
  await m.unmount();
});

test("the touch size keeps the look: the hover and on fills are a 26px pill behind the icon, not the 40×36 box", () => {
  const body = layers[0] ?? "";
  const rule = (sel: string) => {
    const at = body.indexOf(sel + " {");
    assert.notEqual(at, -1, `${sel} exists`);
    return body.slice(at, body.indexOf("}", at));
  };
  assert.match(rule(".chrome-bar-btn--touch:hover, .chrome-bar-btn--touch[data-active]"), /background: transparent/);
  const pill = rule(".chrome-bar-btn--touch::before");
  assert.match(pill, /width: 1\.625rem;/);
  assert.match(pill, /height: 1\.625rem;/);
  assert.match(pill, /border-radius: \.4375rem;/);
  assert.match(rule(".chrome-bar-btn--touch:hover::before"), /background: var\(--color-surface-2\)/);
  assert.match(rule(".chrome-bar-btn--touch[data-active]::before"), /background: var\(--color-surface-3\)/);
});

test("bell receives the click event and its ref", async () => {
  // The bell opens its menu at its own rectangle (e.currentTarget), and the
  // menu's outside-click treats the bell (the ref) as inside.
  const ref = React.createRef<HTMLButtonElement>();
  let seen: EventTarget | null = null;
  const m = await mount({
    label: "Notification settings", size: "touch", ref,
    onClick: (e) => { seen = e.currentTarget; },
  });
  assert.ok(ref.current === m.btn, "the ref is the button element");
  await act(async () => { m.btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.ok(seen === m.btn, "onClick receives the event, currentTarget the button");
  await m.unmount();
});

test("expanded is aria-expanded; active stays visual only", async () => {
  const open = await mount({ label: "Notification settings", expanded: true, active: true });
  assert.equal(open.btn.getAttribute("aria-expanded"), "true");
  assert.equal(open.btn.hasAttribute("aria-pressed"), false);
  await open.unmount();
  const shut = await mount({ label: "Notification settings", expanded: false });
  assert.equal(shut.btn.getAttribute("aria-expanded"), "false");
  await shut.unmount();
  const plain = await mount({ label: "Close" });
  assert.equal(plain.btn.hasAttribute("aria-expanded"), false, "a control that opens nothing says nothing");
  await plain.unmount();
});

// ── Where the touch size is worn ───────────────────────────────────────────

/** Every `<BarButton … />` element, whole (a prop can hold JSX of its own). */
function barButtons(src: string): { at: number; tag: string }[] {
  const out: { at: number; tag: string }[] = [];
  for (let at = src.indexOf("<BarButton"); at !== -1; at = src.indexOf("<BarButton", at + 1)) {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "/" && src[i + 1] === ">" && depth === 0) { out.push({ at, tag: src.slice(at, i + 2) }); break; }
    }
  }
  return out;
}

/** The `center={…}` prop of the first `<Bar slot="top" name="mx-header"`. */
function headerOf(src: string): string {
  const at = src.indexOf('<Bar slot="top" name="mx-header" center={');
  assert.notEqual(at, -1, "the mx-header bar is found");
  const open = src.indexOf("{", src.indexOf("center=", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced header");
}

const timeline = stripComments(read("../../features/community/Timeline.tsx"));

test("the Timeline header's six buttons are touch BarButtons, in order: Back, channels, bell, pins, threads, members", () => {
  const head = headerOf(timeline);
  const tags = barButtons(head);
  const order = [/label="Back"/, /label=\{directoryOpen \? "Hide channels" : "Show channels"\}/,
    /label="Notification settings"/, /label=\{`\$\{pinnedIds\.length\} pinned messages`\}/,
    /label=\{threadsOpen \? "Hide threads" : "Threads"\}/, /label=\{membersOpen \? "Hide members" : "Show members"\}/];
  assert.equal(tags.length, order.length, "six BarButtons in the header, no more");
  order.forEach((re, i) => {
    assert.match(tags[i]!.tag, re, `button ${i + 1} is the expected one`);
    assert.match(tags[i]!.tag, /\bsize="touch"/, `button ${i + 1} wears the touch size`);
  });
  for (let i = 1; i < tags.length; i++) assert.ok(tags[i - 1]!.at < tags[i]!.at);
  assert.doesNotMatch(head, /<button\b/, "no hand-rolled button is left in the header");
  // The bell keeps its ref (outside-click) and its open state for AT.
  assert.match(tags[2]!.tag, /ref=\{bellRef\}/);
  assert.match(tags[2]!.tag, /expanded=\{!!bellAt\}/);
  assert.match(tags[3]!.tag, /expanded=\{pinsOpen\}/);
});

test("the thread, threads-list and pinned-messages heads wear the touch size", () => {
  const thread = stripComments(read("../../features/community/ThreadPanel.tsx"));
  const list = stripComments(read("../../features/community/ThreadsListPanel.tsx"));
  const pins = stripComments(read("../../features/community/PinnedMessages.tsx"));
  for (const [name, src, labels] of [
    ["ThreadPanel", headerOf(thread), [/label="Back to threads"/, /label="Close thread"/]],
    ["ThreadsListPanel", headerOf(list), [/label="Back"/, /label="Close"/]],
  ] as const) {
    const tags = barButtons(src);
    assert.equal(tags.length, labels.length, `${name}: its head's buttons are BarButtons`);
    labels.forEach((re, i) => { assert.match(tags[i]!.tag, re); assert.match(tags[i]!.tag, /\bsize="touch"/); });
    assert.doesNotMatch(src, /<button\b/, `${name}: no hand-rolled head button`);
  }
  const close = barButtons(pins).filter((t) => /label="Close pinned messages"/.test(t.tag));
  assert.equal(close.length, 1, "the pinned panel's ✕ is a BarButton");
  assert.match(close[0]!.tag, /\bsize="touch"/);
});

test("the chat top bar's toggles and its + wear the touch size; the emote button borrows a 44px hit area", () => {
  const tabBar = stripComments(read("../../features/chat/ChatTabBar.tsx"));
  const tags = barButtons(tabBar);
  assert.ok(tags.length >= 5, "compact, split, console, fold and full are all here");
  for (const t of tags) assert.match(t.tag, /\bsize="touch"/, `every chat top-bar toggle: ${t.tag.slice(0, 60)}`);
  // The + and the emote button sit in rows whose height a 40px box would
  // change, so they borrow the area instead of growing (globals.css .tap-hit-44).
  // The whole <button …> element holding a label (`=>` in a handler rules out a [^>]* match).
  const buttonWith = (src: string, label: string) => {
    const at = src.indexOf(`aria-label="${label}"`);
    assert.notEqual(at, -1, `${label}: found`);
    const start = src.lastIndexOf("<button", at);
    return src.slice(start, src.indexOf("</button>", at));
  };
  // The + is a touch BarButton (Task 5b): its borrowed 44px area reached 8px
  // over the strip's 40px "›" box and took the arrow's taps. Since round 1 it
  // is the strip's last item (Sections `trail`), scrolling with the tabs.
  assert.match(tabBar, /trail=\{narrow && unarmedTabs\.length > 0 \? \(\s*<>\s*<BarButton size="touch"\s*ref=\{plusRef\}/, "the + rides in the strip's trailing slot");
  const plus = tags.filter((t) => /label="Add a tab"/.test(t.tag));
  assert.equal(plus.length, 1, "the + is a BarButton");
  assert.match(plus[0]!.tag, /\bsize="touch"/);
  assert.match(plus[0]!.tag, /\bexpanded=\{pickerOpen\}/, "it still says whether its picker is open");
  assert.match(plus[0]!.tag, /\bref=\{plusRef\}/, "and still anchors the picker");
  assert.doesNotMatch(tabBar, /tap-hit-44/, "no borrowed area left in the chat top bar");
  const field = stripComments(read("../ChatComposerField.tsx"));
  assert.match(buttonWith(field, "Emotes"), /className=\{`tap-hit-44 chat-emote-btn /);
});

test("every community header (mx-header) button is a touch BarButton — the forum, DM draft and members headers too", () => {
  const files = ["Timeline", "ThreadPanel", "ThreadsListPanel", "ForumView", "DmDraftPane", "MatrixView", "ChannelColumn"];
  let headers = 0, buttons = 0;
  for (const f of files) {
    const src = stripComments(read(`../../features/community/${f}.tsx`));
    for (let at = src.indexOf('name="mx-header"'); at !== -1; at = src.indexOf('name="mx-header"', at + 1)) {
      const head = headerOf(src.slice(src.lastIndexOf("<Bar", at)));
      headers++;
      assert.doesNotMatch(head, /<button\b/, `${f}: a hand-rolled header button`);
      for (const t of barButtons(head)) { buttons++; assert.match(t.tag, /\bsize="touch"/, `${f}: ${t.tag.slice(0, 80)}`); }
    }
  }
  // The sweep read something: eight headers, and the buttons the ones above hold.
  assert.equal(headers, 8, "eight mx-header bars across the community views");
  assert.ok(buttons >= 14, `the headers' buttons were found (${buttons})`);
});

test("the player's top bar (gear, theatre, fold) wears the touch size", () => {
  const tags = barButtons(stripComments(read("../StreamEmbedBar.tsx")));
  assert.equal(tags.length, 3, "gear, theatre and fold");
  for (const t of tags) assert.match(t.tag, /\bsize="touch"/, t.tag.slice(0, 80));
});

test("vacuity: the Timeline scan read the whole file", () => {
  // The header sits mid-file; a short read would still find it. The end of
  // the component proves the scan reached the bottom.
  assert.match(timeline, /<\/div>\s*\);\s*}\s*$/);
});
