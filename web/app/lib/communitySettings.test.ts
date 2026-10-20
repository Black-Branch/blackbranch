// Community settings: the seventh rail section, its keys, what is a LOOK and what is Behavior,
// and the rule that none of it reaches the /chat window or the OBS source. Source scans, for
// the reason every settingsMenu guard is one (overlayMenu.test.ts's header).
// Run: node --test app/lib/communitySettings.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
const reg = read("app", "lib", "settingsRegistry.ts");
const menu = read("app", "lib", "settingsMenu.ts");
const css = read("app", "globals.css");

const LOOK = ["mxLayout", "mxAvatars", "mxTimes", "mxReactSize"];
const BEHAVIOR = ["mxEditedTag", "mxDeleted", "mxUnread", "mxHideMuted", "mxReceipts", "mxTyping"];
// An entry from its key to its control (the effect sits on the second line).
const entry = (k: string) => new RegExp(`^\\s{2}${k}: E\\(\\{[\\s\\S]*?control:`, "m").exec(reg)?.[0] ?? "";

test("vacuity: both files were read to their end", () => {
  assert.match(reg, /mxTyping: E\(/);
  assert.match(reg, /export function readValues\(\): Values \{[\s\S]*export function setValue|export function setValue[\s\S]*export function readValues\(\): Values \{/, "the registry's END was not read");
  assert.match(menu.slice(-400), /overlaySections/, "settingsMenu.ts read short");
});

test("the Community section's groups and rows, in order", () => {
  const groups = [...menu.matchAll(/\{ title: "([^"]+)", tab: "community", items: \[([^\]]*)\]/g)]
    .map((m) => [m[1], [...m[2]!.matchAll(/s\("(\w+)"/g)].map((x) => x[1])]);
  assert.deepEqual(groups, [
    ["Timeline", ["mxLayout", "mxAvatars", "mxTimes", "mxReactSize"]],
    ["Edits & deletions", ["mxEditedTag", "mxDeleted"]],
    ["Channel list", ["mxUnread", "mxHideMuted"]],
    ["Privacy", ["mxReceipts", "mxTyping"]],
  ]);
  assert.match(menu, /\{ key: "community", label: "Community", icon: ic\(UsersThree\) \}/);
});

test("defaults are the plain Community — nobody sees a change until they touch one; privacy ON", () => {
  for (const [k, v] of [
    ["mxLayout", '"cozy" as MxLayout'], ["mxAvatars", "true"], ["mxTimes", "true"], ["mxReactSize", '"normal" as MxReactSize'],
    ["mxDeleted", '"hide" as "hide" | "placeholder"'], ["mxEditedTag", "true"], ["mxUnread", '"dots" as "dots" | "counts"'],
    ["mxHideMuted", "false"], ["mxReceipts", "true"], ["mxTyping", "true"],
  ] as const) {
    assert.match(reg, new RegExp(`\\n\\s+${k}:\\s+${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`), `${k} default`);
  }
  // Normal reaction size is ×1 = the pill exactly as it was.
  assert.match(reg, /MX_REACT_SCALE: Record<MxReactSize, string> = \{ small: "0\.85", normal: "1", large: "1\.3" \}/);
});

test("the four looks travel with a saved look; the six others are Behavior (Reset leaves them)", () => {
  for (const k of LOOK) {
    assert.ok(entry(k), `${k} has no entry`);
    assert.doesNotMatch(entry(k), /behavior: true/, `${k} is a look`);
  }
  for (const k of BEHAVIOR) assert.match(entry(k), /behavior: true/, `${k} is Behavior`);
  for (const k of [...LOOK, ...BEHAVIOR]) {
    assert.match(entry(k), /prePaint: false/, `${k}: Community renders long after first paint`);
    assert.doesNotMatch(entry(k), /deviceLocal/, `${k} syncs like every other setting`);
  }
});

test("none of it reaches the /chat window or the OBS source", () => {
  const ov = /OVERLAY_KEYS = new Set<SettingKey>\(\[([\s\S]*?)\]\)/.exec(menu)?.[1] ?? "";
  const win = /WINDOW_ONLY_KEYS = new Set<SettingKey>\(\[([\s\S]*?)\]\)/.exec(menu)?.[1] ?? "";
  assert.ok(ov.length > 200, "OVERLAY_KEYS parsed short");
  for (const k of [...LOOK, ...BEHAVIOR]) assert.doesNotMatch(ov + win, new RegExp(`"${k}"`), `${k} is offered on /chat or OBS`);
  // The Behavior six follow the site there (never an ov: copy) — the pre-paint shim lists them.
  const layout = read("app", "layout.tsx");
  const site = /var _SITE=\{([^}]*)\}/.exec(layout)?.[1] ?? "";
  for (const ls of ["chatStyle_mxDeleted", "chatStyle_mxEditedTag", "chatStyle_mxUnread", "chatStyle_mxHideMuted", "chatStyle_mxReceipts", "chatStyle_mxTyping"])
    assert.match(site, new RegExp(`'${ls}':1`), `${ls} missing from the pre-paint site list`);
});

test("the look keys are classes / a var on <html>, and globals.css reads them only inside Community rows", () => {
  assert.match(entry("mxAvatars"), /cls\("mx-avatars-off", !\(v as boolean\)\)/);
  assert.match(entry("mxTimes"), /cls\("mx-times-off", !\(v as boolean\)\)/);
  assert.match(reg, /cls\("mx-compact", v === "compact"\); cls\("mx-bubbles", v === "bubbles"\);/);
  assert.match(reg, /setProp\("--mx-react-scale", MX_REACT_SCALE\[v as MxReactSize\]\)/);
  for (const sel of [".mx-avatars-off .mx-avatar", ".mx-times-off .mx-time", ".mx-compact .mx-row[data-head]", ".mx-bubbles .mx-row[data-head]", ".mx-bubbles .mx-row[data-gend]"])
    assert.ok(css.includes(sel), `globals.css lost ${sel}`);
  // Every rule naming a Community class is scoped to Community markup (.mx-*).
  for (const m of css.matchAll(/^([^{}\n]*\.mx-(?:compact|bubbles|avatars-off|times-off)[^{}\n]*)\{/gm))
    assert.match(m[1]!, /\.mx-(row|avatar|time)\b/, `"${m[1]!.trim()}" reaches beyond Community rows`);
});

test("Community follows the chat's own switches through the SAME classes and vars (no duplicate keys)", () => {
  const row = read("app", "components", "MatrixMessageRow.tsx");
  assert.match(row, /<span className=\{`chat-un-style \$\{nameAnimClass\}`\} style=\{nameStyleCss\}>/, "Name styles (.chat-namestyles-off)");
  assert.match(row, /<PronounMark pronouns=\{look\?\.p\} \/>/, "Pronoun symbols (.chat-pron-off)");
  assert.match(row, /<span className="chat-badges contents">/, "Badges (.chat-badges-off)");
  assert.match(row, /alt \? "chat-msg-alt" : ""/, "Alternating rows (.alt-rows .chat-msg-alt)");
  assert.match(row, /color: "var\(--chat-text-color\)"/, "Colours › Text colour");
  assert.doesNotMatch(row, /text-shadow-chat/, "the fixed shadow class no setting reaches");
  assert.match(css, /\.mx-text \{ text-shadow: var\(--chat-shadow\); \}/, "Effects › Shadow (all its sliders)");
  assert.match(css, /\.mx-row \{ margin-top: max\(0px, calc\(var\(--chat-msg-gap, 1px\) - 1px\)\); \}/, "Text › Message gap, adding nothing at its default");
  assert.match(row, /formatChatTime\(ts, tsFormat, "community-header"\)/, "Text › Timestamp format");
  assert.match(row, /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/, "vacuity anchor");
});
