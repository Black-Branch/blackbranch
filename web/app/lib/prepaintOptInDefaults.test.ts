// The two chat switches that are OFF by default — pronoun symbols and the streamer spotlight — run
// through the REAL pre-paint script (app/layout.tsx), executed in a browser-like window: a viewer who
// never touched them gets the "off" class before first paint; one who switched them on does not.
// A source scan could not tell `=== '0'` from `!== '1'` apart in effect — this runs it.
// Run: node --test app/lib/prepaintOptInDefaults.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
const reg = readFileSync(join(process.cwd(), "app", "lib", "settingsRegistry.ts"), "utf8");
const start = layout.indexOf("__html: `");
const end = layout.indexOf("`}}", start);
assert.ok(start > 0 && end > start, "the pre-paint script body was found");
// The template's one interpolation is the legacy-storage carry (its own test runs it); the rest is
// the literal script, with the template's escapes applied as the build applies them.
const body = layout.slice(start + "__html: `".length, end).replace("${carryLegacyStorageScript()}", "");
assert.ok(!body.includes("${"), "no other interpolation in the script");
const script = (0, eval)("`" + body + "`") as string;

function prepaint(stored: Record<string, string>, path = "/"): DOMTokenList {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://site.test${path}`, runScripts: "outside-only", pretendToBeVisual: true });
  for (const [k, v] of Object.entries(stored)) dom.window.localStorage.setItem(k, v);
  // jsdom has no matchMedia; the script asks it (phone vs computer defaults). A computer answers.
  dom.window.matchMedia = (() => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
  dom.window.eval(script);
  return dom.window.document.documentElement.classList;
}

const OPT_IN = [
  ["pronounsOn", "chatStyle_pronouns", "chat-pron-off"],
  ["spotlightOn", "chatStyle_spotlight", "chat-spotlight-off"],
] as const;

test("registry: pronoun symbols and the streamer spotlight default OFF", () => {
  for (const [key] of OPT_IN) assert.match(reg, new RegExp(`\\n  ${key}:\\s+false,`), key);
});

test("a viewer who never set them: both are off before first paint (the absent key is the default)", () => {
  const cls = prepaint({});
  // Vacuity: the script ran to its end (the emote button, on by default, marks itself on).
  assert.equal(cls.contains("chat-emote-btn-on"), true);
  assert.equal(cls.contains("chat-badges-off"), false);
  for (const [, , off] of OPT_IN) assert.equal(cls.contains(off), true, off);
});

test("switched on ('1'): the off class is not added; switched off ('0'): it is", () => {
  for (const [, ls, off] of OPT_IN) {
    assert.equal(prepaint({ [ls]: "1" }).contains(off), false, `${ls}=1`);
    assert.equal(prepaint({ [ls]: "0" }).contains(off), true, `${ls}=0`);
  }
});

test("the /chat window follows the same defaults (its own keyspace falls back to the site's)", () => {
  for (const [, ls, off] of OPT_IN) {
    assert.equal(prepaint({}, "/chat").contains(off), true, `${ls} absent on /chat`);
    assert.equal(prepaint({ [ls]: "1" }, "/chat").contains(off), false, `${ls}=1 on the site reaches /chat`);
  }
});
