// Behavior: the sixth rail section, its settings, and the rule that Behavior is never part of
// a LOOK — Reset, the preset slots and house looks leave it alone.
//
// Source scans: the registry cannot be imported under node --test (see
// settingsDefaults.test.ts).
// Run: node --test app/lib/behaviorSection.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const root = process.cwd();
const read = (...p: string[]) => stripComments(readFileSync(join(root, ...p), "utf8"));
const reg = read("app", "lib", "settingsRegistry.ts");
const menu = read("app", "lib", "settingsMenu.ts");

const BEHAVIOR_KEYS = ["mentionSound", "mentionHl", "upvoteHl", "eventHl", "spotlightOn", "ownTint", "firstMark", "profanityFilter", "hideBots", "unreadDots", "histLength", "winDock", "winFrom", "termButton",
  // ⑥ Community: what shows + privacy (its four LOOK keys are not Behavior).
  "mxDeleted", "mxEditedTag", "mxUnread", "mxHideMuted", "mxReceipts", "mxTyping"];

const behaviorSections = () => [...menu.matchAll(/\{ title: "([^"]+)", tab: "behavior", items: \[([^\]]*)\]/g)];

test("Behavior is the sixth rail section, after Effects (Community, ⑥, follows it)", () => {
  const tabs = [...menu.matchAll(/\{ key: "(\w+)",\s*label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["text", "rows", "colours", "site", "effects", "behavior", "community"]);
  assert.match(menu, /\{ key: "behavior", label: "Behavior",/);
});

test("its groups hold exactly the Behavior settings, in order (half B added People + Words)", () => {
  const got = behaviorSections().map((m) => [m[1], [...m[2]!.matchAll(/s\("(\w+)"/g)].map((x) => x[1])]);
  assert.deepEqual(got, [
    ["Sound", ["mentionSound"]],
    ["Highlights", ["mentionHl", "upvoteHl", "eventHl", "spotlightOn"]],
    ["Messages", ["ownTint", "firstMark", "profanityFilter"]],
    ["People", ["hideBots"]],
    ["Words", []],
    ["Tabs", ["unreadDots"]],
    ["History", ["histLength"]],
    ["Windows", ["winDock", "winFrom"]],
    ["Terminal", ["termButton"]],
  ]);
});

test("the Terminal group is the Terminal button only — the terminal is the one way into its file", () => {
  assert.match(menu, /\{ title: "Terminal", tab: "behavior", items: \[s\("termButton"\)\], plugin: "console" \}/);
  // Shown only when the install has a console (ChatSettings filters on `plugin`).
  assert.match(read("app", "components", "ChatSettings.tsx"), /const INSTALLED_SECTIONS = SECTIONS\.filter\(\(sec\) => sec\.plugin !== "console" \|\| !!CHAT_CONSOLE\);/);
  for (const k of ["termTheme", "termSize"]) assert.equal(new RegExp(`\\b${k}\\b`).test(reg), false, `${k} is gone from the registry`);
  assert.match(reg, /export function readValues\(\): Values \{/, "vacuity anchor: the END of the registry was read");
});

test("each Behavior setting is listed once in the whole menu (spotlight left Chat rows)", () => {
  for (const k of BEHAVIOR_KEYS) {
    const n = (menu.match(new RegExp(`(?<![A-Za-z])s\\("${k}"`, "g")) ?? []).length;
    assert.equal(n, 1, `${k} listed ${n} times`);
  }
  assert.doesNotMatch(menu, /title: "Highlights", tab: "rows"/, "the old Chat rows › Highlights group is still there");
});

test("every Behavior entry — and only those — carries behavior: true", () => {
  const flagged = [...reg.matchAll(/^\s{2}(\w+): E\(\{[^\n]*\bbehavior: true\b/gm)].map((m) => m[1]).sort();
  assert.deepEqual(flagged, [...BEHAVIOR_KEYS].sort());
});

test("defaults: sound off, highlights on, own tint off, filter off, dots on, history Default", () => {
  for (const [k, v] of [
    ["mentionSound", '"off" as MentionSound'], ["mentionHl", "true"], ["upvoteHl", "true"], ["eventHl", "true"], ["spotlightOn", "true"],
    ["ownTint", "false"], ["profanityFilter", "false"], ["unreadDots", "true"], ["histLength", '"default" as HistoryLength'],
    ["hideBots", "false"], ["firstMark", "true"],
  ] as const) {
    assert.match(reg, new RegExp(`\\n\\s+${k}:\\s+${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`), `${k} default`);
  }
});

test("Reset and applying a look touch LOOK_KEYS only; a saved look omits Behavior", () => {
  assert.match(reg, /export const LOOK_KEYS = SETTING_KEYS\.filter\(\(k\) => !ENTRIES\[k\]\.behavior\)/);
  const cs = read("app", "components", "ChatSettings.tsx");
  const reset = cs.slice(cs.indexOf("function resetToDefaults"), cs.indexOf("function renderControl"));
  assert.match(reset, /LOOK_KEYS\.map/, "Reset writes defaults over Behavior");
  assert.doesNotMatch(reset, /SETTING_KEYS/, "Reset still walks every key");
  const apply = cs.slice(cs.indexOf("const applyBlob"), cs.indexOf("function resetToDefaults"));
  assert.match(apply, /for \(const key of LOOK_KEYS\)/, "applying a preset/house look overwrites Behavior");
  const slots = read("app", "components", "PresetSlots.tsx");
  assert.doesNotMatch(slots, /collectLocalSettings\(\)/, "a preset slot still saves Behavior with the look");
  // One save path through the shared store since step 3b; it is handed the look-only blob.
  assert.match(slots, /savePreset\(store\(\), n, collectLookSettings\(\)\)/, "the save does not use the look-only blob");
  const keys = read("app", "lib", "settingsKeys.ts");
  assert.match(keys, /export function collectLookSettings\(\)/);
});

test("People and Words carry the account-list panels", () => {
  assert.match(menu, /\{ title: "People", tab: "behavior", items: \[s\("hideBots"\)\], panel: "people" \}/);
  assert.match(menu, /\{ title: "Words", tab: "behavior", items: \[\], panel: "words" \}/);
  assert.match(menu, /panel\?: "people" \| "words";/);
  const cs = read("app", "components", "ChatSettings.tsx");
  assert.match(cs, /\{section\.panel && <BehaviorListPanel kind=\{section\.panel\} \/>\}/);
  // No terminal.conf box in Settings — and so no /api/term call from opening Settings.
  assert.equal(existsSync(join(root, "app", "components", "TerminalConfPanel.tsx")), false, "the terminal.conf box is gone");
});

test("vacuity: the files were read to their end", () => {
  assert.ok(/overlaySections/.test(menu.slice(-400)), "settingsMenu.ts read short");
  assert.ok(reg.length > 20000, "settingsRegistry.ts read short");
});

test("on /chat and the OBS page, Behavior with no control there follows the site live", () => {
  // settingGet and the pre-paint shim would otherwise SEED a one-time copy into
  // the "ov:" keyspace — frozen forever, with no control on that page to change it.
  const flagged = [...reg.matchAll(/^\s{2}\w+: E\(\{ ls: "(\w+)"[^\n]*\bbehavior: true\b/gm)]
    .filter((m) => !/deviceLocal: true/.test(m[0])).map((m) => m[1]).sort();
  assert.ok(flagged.length >= 6, `parsed ${flagged.length}`);
  assert.match(reg, /export const SITE_SCOPED_LS = new Set\(SETTING_KEYS\.filter\(\(k\) => ENTRIES\[k\]\.behavior && !ENTRIES\[k\]\.deviceLocal\)/);
  assert.match(reg, /if \(!sc \|\| SITE_SCOPED_LS\.has\(lsKey\)\) return lsGet\(lsKey\);/);
  const layout = read("app", "layout.tsx");
  const m = /var _SITE=\{([^}]*)\}/.exec(layout);
  assert.ok(m, "the pre-paint shim has no site-scoped list");
  const listed = [...m[1]!.matchAll(/'(\w+)':1/g)].map((x) => x[1]).sort();
  assert.deepEqual(listed, flagged, "the pre-paint list and the registry disagree");
  assert.match(layout, /getItem:function\(k\)\{if\(_SITE\[k\]\)return _rLS\.getItem\(k\);/);
  // …and none of them is offered in the window/OBS menus.
  const menuSrc = read("app", "lib", "settingsMenu.ts");
  const ovKeys = /OVERLAY_KEYS = new Set<SettingKey>\(\[([\s\S]*?)\]\)/.exec(menuSrc)?.[1] ?? "";
  const winKeys = /WINDOW_ONLY_KEYS = new Set<SettingKey>\(\[([\s\S]*?)\]\)/.exec(menuSrc)?.[1] ?? "";
  for (const k of ["mentionSound", "mentionHl", "upvoteHl", "eventHl", "spotlightOn", "ownTint", "firstMark", "profanityFilter", "hideBots", "unreadDots"]) {
    assert.doesNotMatch(ovKeys + winKeys, new RegExp(`"${k}"`), `${k} has a window control but follows the site`);
  }
  assert.match(winKeys, /"histLength"/);
});
