// Chat-row switches that are pure CSS: name styles, badges, pronoun colour,
// send-to button, "+" tools button, ring thickness (settings reorg part 1,
// task 6). Each toggle is a class on <html> flipped by the pre-paint script
// and a registry entry; no row re-render is involved.
//
// Run: node --test app/lib/rowSwitches.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 500); return stripComments(r); };
const REG = read("app", "lib", "settingsRegistry.ts");
const CSS = read("app", "globals.css");
const LAYOUT = read("app", "layout.tsx");

const SWITCHES = [
  ["nameStylesOn", "chatStyle_nameStyles", "chat-namestyles-off"],
  ["badgesOn", "chatStyle_badges", "chat-badges-off"],
  ["sendToBtnOn", "chatStyle_sendToBtn", "chat-sendto-btn-off"],
  ["toolsBtnOn", "chatStyle_toolsBtn", "chat-tools-btn-off"],
] as const;

test("each switch defaults ON, is prePaint, and marks only its OFF state", () => {
  for (const [key, ls, cls] of SWITCHES) {
    assert.match(REG, new RegExp(`${key}:\\s*true,`), `${key} must default on (today's look)`);
    assert.match(REG, new RegExp(`${key}: E\\(\\{ ls: "${ls}", prePaint: true,[\\s\\S]*?cls\\("${cls}", !\\(v as boolean\\)\\)`));
    assert.ok(LAYOUT.includes(`localStorage.getItem('${ls}')==='0'`), `pre-paint does not restore ${ls}`);
    assert.ok(CSS.includes(`.${cls} `), `no CSS for .${cls}`);
  }
});

test("name styles OFF resets every property usernameStyleCSS can write", () => {
  const styles = read("app", "lib", "usernameStyles.ts");
  const props = new Set([...styles.matchAll(/css\.(\w+)\s*=/g)].map((m) => m[1]!));
  assert.ok(props.size >= 4, `parsed only ${props.size} style properties`);
  const rule = CSS.match(/\.chat-namestyles-off \.chat-un-style \{([^}]*)\}/)?.[1] ?? "";
  const kebab = (p: string) => p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/^webkit-/, "-webkit-");
  for (const p of props) assert.ok(rule.includes(kebab(p)), `name-styles-off does not reset ${p}`);
  assert.match(read("app", "features", "chat", "ChatMessage.tsx"), /className=\{`chat-un-style \$\{unAnimClass\}`\}/);
});

test("pronoun colour: Coloured default; Plain is a fixed light grey", () => {
  assert.match(REG, /pronounColor:\s*"coloured"/);
  // Chat rows only — never an unscoped rule that reaches cards/lists.
  assert.match(CSS, /\.chat-pron-plain \.chat-msg-row \.chat-pron \{ color: #c3cddb !important; \}/);
  assert.doesNotMatch(CSS, /\.chat-pron-plain \.chat-pron\b/, "plain pronoun colour must be scoped to chat rows");
  // The scope only works while PronounMark renders inside the row.
  const cm = read("app", "features", "chat", "ChatMessage.tsx");
  const row = cm.indexOf("chat-msg-row"), mark = cm.indexOf("<PronounMark");
  assert.ok(row > -1 && mark > row, "PronounMark must render inside the .chat-msg-row root");
});

test("ring thickness defaults to today's 2px and feeds the ring", () => {
  assert.match(REG, /pfpRingWidth:\s*2,/);
  assert.match(CSS, /\.chat-pfp-ring-on \{ --chat-pfp-ring: var\(--chat-pfp-ring-w, 2px\); \}/);
});
