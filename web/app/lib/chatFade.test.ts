// Chat top fade — rows fade to nothing at the top of the
// chat, or at the pin's bottom while a pin shows. A mask on the scroller; it
// fails silently if a wire comes loose, so the wires are pinned.
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/chatFade.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const css = read("app", "globals.css");

test("the scroller fades to TRANSPARENT from the fade line over --chat-fade-h, unless the setting is off", () => {
  const rule = css.match(/:root:not\(\.chat-fade-off\) \.chat-scroll-layer \{([^}]*)\}/)?.[1] ?? "";
  const grad = "linear-gradient(to bottom, transparent var(--chat-fade-top), #000 calc(var(--chat-fade-top) + var(--chat-fade-h)))";
  assert.ok(rule.includes(`-webkit-mask-image: ${grad};`) && rule.includes(`  mask-image: ${grad};`), "the fade mask changed or is gone");
  assert.match(css, /--chat-fade-top:\s+0px;/);
  assert.match(css, /--chat-fade-h:\s+64px;/);
});

test("no per-row roll comes back: it squashed message by message and layered every row", () => {
  assert.doesNotMatch(css, /animation-timeline|@keyframes chat-roll|chat-roll-band/);
});

test("both chat surfaces move the fade line to the pin's bottom", () => {
  assert.match(read("app", "features", "chat", "ChatWindow.tsx"), /\{ paddingTop: pinHeight, "--chat-fade-top": `\$\{pinHeight\}px` \} as (React\.)?CSSProperties/, "ChatWindow.tsx");
  // The side panel sets it on the message AREA since round 2b, so the area's
  // top darkening starts below the pin as well as the scroller's mask.
  const side = read("app", "features", "chat", "ChatSidebar.tsx");
  assert.match(side, /pinShown \? \{ "--chat-fade-top": `\$\{pinHeight\}px` \} : null/, "ChatSidebar.tsx: the area");
  assert.match(side, /style=\{pinShown \? \{ paddingTop: pinHeight \} : undefined\}/, "ChatSidebar.tsx: the scroller still pads for the pin");
});

test("the setting: default on, class marks OFF, listed once — in Effects", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /chatFade:\s*true,/);
  assert.match(reg, /chatFade: E\(\{ ls: "chatStyle_chatFade", prePaint: false,\s*serialize: ser1, parse: bool1, effect: \(v\) => cls\("chat-fade-off", !\(v as boolean\)\),/);
  // Every switch has one home in the rail.
  const menu = read("app", "lib", "settingsMenu.ts");
  assert.equal((menu.match(/s\("chatFade"\)/g) ?? []).length, 1);
  assert.match(menu.match(/\{ title: "Effects", tab: "effects", items: \[[^\]]*\]/)?.[0] ?? "", /s\("chatFade"\)/);
});

// Vacuity anchor at the END: the registry label is the one the viewer sees.
test("the toggle reads 'Fade chat at the top'", () => {
  assert.match(read("app", "lib", "settingsRegistry.ts"), /label: "Fade chat at the top"/);
});
