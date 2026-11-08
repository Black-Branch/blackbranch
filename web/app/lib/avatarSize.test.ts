// #236 "universalize pfp sizes": ONE avatar scale for every picture of a person or room.
//
// The defect: `Avatar`'s `size` was px "at the default 14px chat font", multiplied by the frozen
// row basis (21.6px) AND the Chat rows › Avatar size slider. So the DM list's `size={32}` drew a
// 49px picture — 69px at a 1.4× slider — while the member list beside it drew 32px, the profile
// cards 64px by hand, the rail 36px and 40px side by side. No two surfaces agreed and none could
// be read off the code.
//
// Now: the steps live in globals.css (`--avatar-xs … --avatar-xl`, `--avatar-line`), every
// picture takes one by name, and only the pictures IN a chat row answer to the Avatar-size
// slider. jsdom has no layout, so this pins the TERMS the boxes are built from; the pixels are
// the look run (task-233-236 report).
//
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/lib/avatarSize.test.ts
import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dom, React, act } from "./testDom.ts";
import { stripCssComments, stripComments } from "./testSource.ts";
import "./testTsx.ts";

const { AVATAR_PX, avatarSize } = await import("./avatarSize.ts");
type Step = keyof typeof AVATAR_PX;
const AVATAR_STEPS = Object.keys(AVATAR_PX) as Step[];
const { Avatar } = await import("../components/Avatar.tsx");
const { createRoot } = await import("react-dom/client");

const APP = new URL("../", import.meta.url);
const css = stripCssComments(readFileSync(new URL("globals.css", APP), "utf8"));

// ── The scale itself ─────────────────────────────────────────────────────────

test("globals.css declares the one scale, and the px table restates it exactly", () => {
  for (const step of ["xs", "sm", "md", "lg", "xl"] as const) {
    const m = new RegExp(`--avatar-${step}: ([0-9.]+)rem;`).exec(css);
    assert.ok(m, `--avatar-${step} is declared in rem`);
    assert.equal(Number(m![1]) * 16, AVATAR_PX[step], `--avatar-${step} and AVATAR_PX.${step} are the same size`);
  }
  // The live chat row's picture is one chat line tall: the frozen row basis, not a new number.
  assert.match(css, /--avatar-line: var\(--chat-row-basis\);/);
  assert.deepEqual([...AVATAR_STEPS].sort(), ["lg", "line", "md", "sm", "xl", "xs"]);
});

test("a step is its token; only a chat row's picture is × the Avatar-size slider", () => {
  assert.equal(avatarSize("md"), "var(--avatar-md)");
  assert.equal(avatarSize("xl"), "var(--avatar-xl)");
  assert.equal(avatarSize("line", true), "calc(var(--avatar-line) * var(--chat-pfp-scale, 1))");
  assert.equal(avatarSize("xs", true), "calc(var(--avatar-xs) * var(--chat-pfp-scale, 1))");
});

test("the .avatar box is the step, snapped to whole pixels, and round", () => {
  const rule = /\.avatar \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /--avatar-box: round\(var\(--avatar-size, var\(--avatar-md\)\), 2px\);/);
  assert.match(rule, /width: var\(--avatar-box\);/);
  assert.match(rule, /height: var\(--avatar-box\);/);
  assert.match(rule, /border-radius: 9999px;/);
});

test("the Community gutter is built from the same scale (40 wide, 32 narrow, × the slider)", () => {
  assert.match(css, /\.mx-row \{[^}]*--mx-gutter-avatar-base: var\(--avatar-lg\);/);
  assert.match(css, /\.mx-row \{[^}]*--mx-gutter-avatar: round\(calc\(var\(--mx-gutter-avatar-base\) \* var\(--chat-pfp-scale, 1\)\), 2px\);/);
  assert.match(css, /\[data-mx-pane="narrow"\] \.mx-row \{ --mx-gutter-avatar-base: var\(--avatar-md\); \}/);
});

// ── The component ────────────────────────────────────────────────────────────

async function mount(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { pic: host.firstElementChild as HTMLElement, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

for (const step of AVATAR_STEPS) {
  test(`Avatar size="${step}" takes its box from the token, never a px literal`, async () => {
    for (const mxcUrl of [null, "mxc://site.test/pic"]) {
      const m = await mount(React.createElement(Avatar, { mxcUrl, name: "Robin", size: step }));
      assert.ok(m.pic.classList.contains("avatar"), `${step}: the picture wears the scale's class`);
      assert.equal(m.pic.style.getPropertyValue("--avatar-size"), `var(--avatar-${step})`);
      const style = m.pic.getAttribute("style") ?? "";
      assert.doesNotMatch(style, /\d(px|rem)/, `${step}: no literal size on the element (${style})`);
      assert.doesNotMatch(style, /chat-pfp-scale/, `${step}: a picture outside a chat row ignores the Avatar-size slider`);
      await m.unmount();
    }
  });
}

test("a chat row's picture is × the slider, and a stylesheet box (the Cozy gutter) wins when set", async () => {
  const m = await mount(React.createElement(Avatar, { mxcUrl: null, name: "Robin", size: "line", scaled: true, box: "--mx-avatar-box" }));
  assert.equal(m.pic.style.getPropertyValue("--avatar-size"), "var(--mx-avatar-box, calc(var(--avatar-line) * var(--chat-pfp-scale, 1)))");
  await m.unmount();
});

test("the picture asks for a thumbnail that covers its step at 2x", async () => {
  const m = await mount(React.createElement(Avatar, { mxcUrl: "mxc://site.test/pic", name: "Robin", size: "md" }));
  // 32px at 2x = 64 → Synapse's 96 crop (mxcToHttp rounds up to the sizes Synapse keeps).
  assert.match(m.pic.getAttribute("src") ?? "", /width=96&/);
  await m.unmount();
});

// ── Every picture on the site takes a step ───────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); }
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}
const files = walk(new URL(".", APP).pathname);
// RigOverlay's `Avatar` is the overlay's own bot face (a 240px SVG puppet), not this component.
const callers = files.filter((f) => !f.endsWith("RigOverlay.tsx") && /from "@\/app\/components\/Avatar"|from "\.\/Avatar"|from "\.\.\/Avatar"/.test(readFileSync(f, "utf8")));

test("every <Avatar> call names a step from the scale; none passes a number", () => {
  let calls = 0;
  for (const f of callers) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(/<Avatar\b([^>]*?)\/>/g)) {
      calls++;
      assert.match(m[1]!, /\bsize="(xs|sm|md|lg|xl|line)"|\bsize=\{avatarStep\}/, `${f}: ${m[0].replace(/\s+/g, " ")}`);
      assert.doesNotMatch(m[1]!, /\bsize=\{\d/, `${f}: a numeric size`);
    }
  }
  // Vacuity: the scan read the call sites (14 files import Avatar, 13 calls, when this was written).
  assert.ok(callers.length >= 10, `found ${callers.length} files importing Avatar`);
  assert.ok(calls >= 13, `found ${calls} <Avatar> calls`);
});

// The pictures drawn without <Avatar> (an <img> plus the shared letter circle): each takes its
// box from the same scale through `avatarStyle`, and keeps no hand-picked Tailwind size.
const HAND_DRAWN: [file: string, steps: string[]][] = [
  ["components/UserCard.tsx", ["xl"]],
  ["components/ProfileCardBody.tsx", ["xl"]],
  ["components/StreamMetaBar.tsx", ["md"]],
  ["components/CommunityChooser.tsx", ["sm"]],
  ["features/community/SpacesRail.tsx", ["lg"]],
];
for (const [file, steps] of HAND_DRAWN) {
  test(`${file}: its picture takes a step (${steps.join(", ")}) from the scale`, () => {
    const raw = readFileSync(new URL(file, APP), "utf8");
    const src = stripComments(raw);
    for (const s of steps) assert.match(src, new RegExp(`avatarStyle\\("${s}"\\)`), `${file} sizes its picture with avatarStyle("${s}")`);
    assert.doesNotMatch(src, /\bw-(6|8|9|16) h-(6|8|9|16) rounded-full/, `${file} still hand-sizes a round picture`);
    // Vacuity: the negative above read the whole file — its last line is in the scanned text.
    const lastLine = raw.trimEnd().split("\n").reverse().map((l) => l.trim()).find((l) => /\w/.test(l) && !l.startsWith("//"))!;
    assert.ok(lastLine.length > 0 && src.includes(lastLine), `${file} was read to its end`);
  });
}
