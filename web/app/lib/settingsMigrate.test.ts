// web/app/lib/settingsMigrate.test.ts
// The saved-settings converter. Pure module → imported directly.
// Run: node --test app/lib/settingsMigrate.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  migrateSettingsBlob, migrateStore, migrateHistLength, REMOVED_V2_KEYS,
  SETTINGS_VERSION_KEY, CURRENT_SETTINGS_VERSION, type KeyStore,
} from "./settingsMigrate.ts";

const V: Record<string, string> = { [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_VERSION };

test("a default (empty) blob only gains the stamp", () => {
  assert.deepEqual(migrateSettingsBlob({}), V);
});

test("custom panel: tint ← chat top, body strength ← chat opacity, bar strength ← video opacity", () => {
  const out = migrateSettingsBlob({
    theme_bgStart: "#1a0b2e", theme_bgEnd: "#050208",
    theme_chatStart: "#2a1d4a", theme_chatEnd: "#170f2e", theme_chatOpacity: "0.8",
    theme_videoStart: "#301f55", theme_videoEnd: "#1a1030", theme_videoOpacity: "0.65",
    chatStyle_fontWeight: "500",
  });
  assert.deepEqual(out, {
    theme_bgStart: "#1a0b2e", theme_bgEnd: "#050208",
    theme_panelTint: "#2a1d4a", theme_bodyStrength: "0.8", theme_barStrength: "0.65",
    chatStyle_fontWeight: "500", ...V,
  } as Record<string, string>);
});

test("separate chat bars ON: bar colours are dropped (an accepted shift)", () => {
  const out = migrateSettingsBlob({
    theme_chatBarsOn: "1", theme_chatBarTop: "#ff00aa", theme_chatBarBottom: "#00ffaa", theme_chatBarOpacity: "0.5",
  });
  assert.deepEqual(out, V);
});

test("switch OFF but colours still stored: nothing resurrects them", () => {
  const out = migrateSettingsBlob({ theme_chatBarsOn: "0", theme_chatBarTop: "#ff0000", theme_chatBarBottom: "#00ff00" });
  assert.deepEqual(out, V);
  assert.equal(out.theme_panelTint, undefined);
});

test("every removed key is dropped, and nothing else changes value", () => {
  const input: Record<string, string> = { chatStyle_platformIndicator: "icon", chatStyle_piSat: "2" };
  for (const k of REMOVED_V2_KEYS) input[k] = "1";
  const out = migrateSettingsBlob(input);
  for (const k of REMOVED_V2_KEYS) assert.equal(out[k], undefined, `${k} survived`);
  assert.equal(out.chatStyle_platformIndicator, "icon");
  assert.equal(out.chatStyle_piSat, "2");
});

test("icon-mode user keeps icon mode; their icon size is dropped", () => {
  const out = migrateSettingsBlob({ chatStyle_platformIndicator: "icon", chatStyle_iconScale: "0.8" });
  assert.deepEqual(out, { chatStyle_platformIndicator: "icon", ...V } as Record<string, string>);
});

test("reduced chat history is NOT converted in v2 (part 2 does it)", () => {
  assert.equal(migrateSettingsBlob({ chatStyle_histReduced: "1" }).chatStyle_histReduced, "1");
});

test("an already-stamped blob comes back untouched (idempotent)", () => {
  const v2 = { theme_panelTint: "#123456", theme_chatStart: "#ffffff", ...V } as Record<string, string>;
  assert.deepEqual(migrateSettingsBlob(v2), v2);
  const once = migrateSettingsBlob({ theme_chatStart: "#2a1d4a" });
  assert.deepEqual(migrateSettingsBlob(once), once);
});

test("an explicit v2 value is never overwritten by a leftover v1 one", () => {
  const out = migrateSettingsBlob({ theme_panelTint: "#abcdef", theme_chatStart: "#2a1d4a" });
  assert.equal(out.theme_panelTint, "#abcdef");
});

test("non-string values are stringified; null/undefined dropped (a DB jsonb blob)", () => {
  const out = migrateSettingsBlob({ chatStyle_msgGap: 3, chatStyle_pfp: null, theme_videoOpacity: 0.5 } as Record<string, unknown>);
  assert.deepEqual(out, { chatStyle_msgGap: "3", theme_barStrength: "0.5", ...V } as Record<string, string>);
});

function memStore(init: Record<string, string>): KeyStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

test("migrateStore converts one keyspace in place and stamps it", () => {
  const s = memStore({ theme_chatStart: "#2a1d4a", theme_chatBarsOn: "1", chatStyle_fontWeight: "500" });
  assert.equal(migrateStore(s), true);
  assert.deepEqual(s.data, { theme_panelTint: "#2a1d4a", chatStyle_fontWeight: "500", settingsVersion: "2" });
  assert.equal(migrateStore(s), false, "second run must be a no-op");
});

test("the ov: keyspace converts separately and never touches site keys", () => {
  const s = memStore({ "ov:theme_chatOpacity": "0.4", theme_chatOpacity: "0.9" });
  migrateStore(s, "ov:");
  assert.deepEqual(s.data, { "ov:theme_bodyStrength": "0.4", "ov:settingsVersion": "2", theme_chatOpacity: "0.9" });
});

test("site converts before ov: a lazy ov: seed after conversion copies v2 values", () => {
  const s = memStore({ theme_chatStart: "#2a1d4a" });
  migrateStore(s, "");
  migrateStore(s, "ov:");
  // settingGet on the overlay seeds ov:<k> from <k> — after the site pass the
  // only thing left to seed is the v2 key.
  assert.equal(s.data.theme_chatStart, undefined);
  assert.equal(s.data.theme_panelTint, "#2a1d4a");
});

test("PUT of an unstamped v1 blob keeps the panel tint (old tab after deploy)", () => {
  // sanitizeSettingsBlob runs migrateSettingsBlob FIRST; simulate its order here.
  const incoming = { theme_chatStart: "#2a1d4a", theme_chatOpacity: "0.7" };
  const migrated = migrateSettingsBlob(incoming);
  assert.equal(migrated.theme_panelTint, "#2a1d4a");
  assert.equal(migrated.theme_bodyStrength, "0.7");
});

// Behavior: "Reduced chat history" became Chat history length. An old ON must
// read as Short in the MENU too, not only in the buffer. The old switch was
// read from the site key by both the site and /chat, so it converts both
// keyspaces from that one key.
test("an old Reduced chat history ON becomes Short in both keyspaces, once", () => {
  const data: Record<string, string> = { chatStyle_histReduced: "1" };
  const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; }, removeItem: (k: string) => { delete data[k]; } };
  migrateHistLength(store);
  assert.deepEqual(data, { chatStyle_histLength: "short", "ov:chatStyle_histLength": "short" });
  data["ov:chatStyle_histLength"] = "long";
  migrateHistLength(store);
  assert.equal(data["ov:chatStyle_histLength"], "long", "a later pick was overwritten");
});

test("a picked length is kept; an old OFF just goes", () => {
  const data: Record<string, string> = { chatStyle_histReduced: "1", chatStyle_histLength: "long", "ov:chatStyle_histReduced": "0" };
  const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; }, removeItem: (k: string) => { delete data[k]; } };
  migrateHistLength(store);
  assert.deepEqual(data, { chatStyle_histLength: "long", "ov:chatStyle_histLength": "short" });
  const off: Record<string, string> = { chatStyle_histReduced: "0" };
  migrateHistLength({ getItem: (k) => off[k] ?? null, setItem: (k, v) => { off[k] = v; }, removeItem: (k) => { delete off[k]; } });
  assert.deepEqual(off, {});
});
