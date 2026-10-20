// Behavior › Highlights › Support events — off = no tint behind tip/sub/gift
// cards; the card's own text and icon stay.
// Run: node --test app/lib/supportEventsSwitch.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("the switch exists, defaults on, and sits under Behavior › Highlights", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /\n  eventHl: {5}true,/, "missing from DEFAULTS, or not on by default");
  assert.match(reg, /eventHl: E\(\{ ls: "chatStyle_eventHl", prePaint: true, behavior: true,\s*serialize: ser1, parse: bool1, effect: \(v\) => cls\("chat-event-hl-off", !\(v as boolean\)\),\s*control: \{ kind: "toggle", label: "Support events" \} \}\)/);
  assert.match(read("app", "lib", "settingsMenu.ts"), /title: "Highlights", tab: "behavior", items: \[[^\]]*s\("eventHl"\)/);
});

test("off clears the event tint, and only the tint — the stripe and hover come back", () => {
  const msg = read("app", "features", "chat", "ChatMessage.tsx");
  // A CLASS, not an inline background: an inline one (even "transparent") beats
  // the stripe and the hover, so switching it off left gaps in the striped chat.
  assert.match(msg, /\["--row-event-bg" as string\]: eventBgColor/);
  assert.match(msg, /eventBgColor \? "chat-row-event " : ""/);
  assert.doesNotMatch(msg, /backgroundColor: eventBgColor/);
  const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
  assert.match(css, /html:not\(\.chat-event-hl-off\) \.chat-msg-row\.chat-row-event \{ background-color: var\(--row-event-bg\); \}/);
  assert.ok(css.length > 20000, "vacuity: globals.css read to its end");
});

test("it is applied before first paint", () => {
  assert.match(read("app", "layout.tsx"), /localStorage\.getItem\('chatStyle_eventHl'\)==='0'\) document\.documentElement\.classList\.add\('chat-event-hl-off'\)/);
});
