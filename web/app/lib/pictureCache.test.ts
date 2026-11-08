// The page half of the picture cache (#244): the four device-only switches, their defaults (on),
// the warm obeying "Emotes and stickers", the cache names shared with the worker, and the menu
// group. The worker's own policy is swPictureCache.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testDom.ts";
import "./testTsx.ts"; // the registry's own imports are extensionless
// Loaded after the loader above: these modules' own imports are extensionless.
const { readPicturePolicy, emoteCacheOn, formatBytes, startPictureCache, PICTURE_CACHES, WARM_RECORD_KEY } = await import("./pictureCache.ts");
const { DEFAULTS, ENTRIES, LOOK_KEYS } = await import("./settingsRegistry.ts");
const { warmEmotes } = await import("./emoteWarmer.ts");

const KEYS = ["pictureCache", "pictureCacheEmotes", "pictureCacheAvatars", "pictureCachePreviews"] as const;

test("a viewer who touches nothing caches everything (every switch defaults ON)", () => {
  assert.deepEqual(readPicturePolicy(() => null), { on: true, emotes: true, avatars: true, previews: true });
  for (const k of KEYS) assert.equal(DEFAULTS[k], true, `${k} is not on by default`);
});

test("a switch turned off reads off; anything unreadable reads as the default", () => {
  const off = (ls: string) => (ls === "chatStyle_pictureCacheAvatars" ? "0" : null);
  assert.deepEqual(readPicturePolicy(off), { on: true, emotes: true, avatars: false, previews: true });
  assert.equal(readPicturePolicy((ls) => (ls === "chatStyle_pictureCache" ? "0" : "1")).on, false);
  assert.equal(emoteCacheOn({ on: false, emotes: true, avatars: true, previews: true }), false, "the master switch does not govern emotes");
  assert.equal(emoteCacheOn({ on: true, emotes: false, avatars: true, previews: true }), false);
  assert.equal(emoteCacheOn(readPicturePolicy(() => null)), true);
});

test("the switches are per device, never part of a look, never painted before first paint", () => {
  for (const k of KEYS) {
    const e = ENTRIES[k];
    assert.equal(e.deviceLocal, true, `${k} would roam to the account`);
    assert.equal(e.behavior, true, `${k} would be reset by Reset or a preset`);
    assert.equal(e.prePaint, false);
    assert.equal(e.control.kind, "toggle");
    assert.ok(!LOOK_KEYS.includes(k));
  }
  assert.equal(ENTRIES.pictureCache.control.kind === "toggle" && ENTRIES.pictureCache.control.label, "Cache pictures on this device");
});

test("the page and the worker name the same caches", () => {
  const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  assert.match(sw.slice(-600), /\}\s*$/, "vacuity anchor: sw.js read truncated");
  for (const name of PICTURE_CACHES) assert.ok(sw.includes(`"${name}"`), `sw.js has no cache named ${name}`);
  const warmer = readFileSync(new URL("./emoteWarmer.ts", import.meta.url), "utf8");
  assert.match(warmer, /const RECORD_KEY = WARM_RECORD_KEY;/, "Clear cached pictures forgets a different record than the warm keeps");
});

test("Settings › Site & bars has the Storage group: master, three kinds under it, the size panel", () => {
  const src = readFileSync(new URL("./settingsMenu.ts", import.meta.url), "utf8");
  const at = src.indexOf('title: "Storage on this device"');
  assert.notEqual(at, -1, "the Storage on this device group is gone");
  const group = src.slice(at, src.indexOf("},", src.indexOf('panel: "storage"', at)));
  assert.match(group, /tab: "site"/);
  assert.match(group, /s\("pictureCache"\)/);
  for (const k of KEYS.slice(1)) assert.match(group, new RegExp(`s\\("${k}", \\(v\\) => v\\.pictureCache\\)`), `${k} is not shown under the master switch`);
  assert.match(group, /panel: "storage"/);
});

test("formatBytes says what a person reads", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(840_000), "840 KB");
  assert.equal(formatBytes(12_340_000), "12.3 MB");
});

// The warm is real here: a fetch double counts what it asks for.
function warmWith(stored: Record<string, string>): string[] {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  const asked: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (u: string) => { asked.push(String(u)); return new Response(""); };
  const n = Math.random().toString(36).slice(2);
  warmEmotes({ [`e${n}`]: { url: `https://cdn.7tv.app/emote/${n}/2x.webp`, zeroWidth: false, r: 1, s: 1 } });
  return asked;
}

test("emotes and stickers switched off → the warm downloads nothing; on (the default) → it warms", async () => {
  assert.deepEqual(warmWith({ chatStyle_pictureCacheEmotes: "0" }), [], "the warm ran with the emote cache off");
  assert.deepEqual(warmWith({ chatStyle_pictureCache: "0" }), [], "the warm ran with the master switch off");
  const on = warmWith({});
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(on.some((u) => !u.includes("/4x")), "the default warmed no chat emote");
  assert.ok(on.some((u) => u.includes("/4x.webp")), "the default warmed no sticker rung");
});

test("turning the emote cache off forgets the warm record, so turning it on again refills the cache", async () => {
  localStorage.setItem(WARM_RECORD_KEY, JSON.stringify({ k: "x", t: Date.now(), tier: "all" }));
  localStorage.setItem("chatStyle_pictureCacheEmotes", "0");
  startPictureCache();
  assert.equal(localStorage.getItem(WARM_RECORD_KEY), null);
});
