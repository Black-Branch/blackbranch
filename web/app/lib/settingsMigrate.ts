// web/app/lib/settingsMigrate.ts
// Saved-settings converter.
//
// A settings BLOB is the flat { lsKey: string } map that lives in three places:
// site.user_settings / site.setting_presets (jsonb), and each browser's
// localStorage (two keyspaces: "" and "ov:"). This module turns an old-layout
// blob into the current one and stamps it, so every place converts to the SAME
// result exactly once. Viewers never see the stamp.
//
// PURE and import-free on purpose: node --test imports it directly, and the
// server routes and any one-off database conversion call the same function.
// One converter, not several that must agree.

export const SETTINGS_VERSION_KEY = "settingsVersion";
// @test-only exported so tests can assert the current stamp value without
// hardcoding "2" — every production caller only ever compares against
// SETTINGS_VERSION_KEY's stored value, never against this literal directly.
export const CURRENT_SETTINGS_VERSION = "2";

/** Keys v2 stops reading. The converter deletes them.
 *  @test-only exported so tests can iterate the exact removed-key list
 *  instead of duplicating it (settingsMigrate.test.ts). */
export const REMOVED_V2_KEYS = [
  "chatStyle_usernameSize",
  "chatStyle_iconScale",
  "theme_barColor",
  "chatStyle_timerGlow",
  "chatStyle_foldedControls",
  "theme_videoStart", "theme_videoEnd", "theme_videoOpacity",
  "theme_chatStart", "theme_chatEnd", "theme_chatOpacity",
  "theme_chatBarsOn", "theme_chatBarTop", "theme_chatBarBottom", "theme_chatBarOpacity",
] as const;

/** v1 key → the v2 key that inherits its value (panel colours model B).
 *  Per-bar colours have no heir: those looks shift, by decision. */
const CARRY_V2: ReadonlyArray<readonly [from: string, to: string]> = [
  ["theme_chatStart", "theme_panelTint"],
  ["theme_chatOpacity", "theme_bodyStrength"],
  ["theme_videoOpacity", "theme_barStrength"],
];

export function migrateSettingsBlob(input: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v != null) out[k] = String(v);
  if (out[SETTINGS_VERSION_KEY] === CURRENT_SETTINGS_VERSION) return out;

  // v1 → v2. A v2 key that is already present wins over its v1 source.
  for (const [from, to] of CARRY_V2) {
    if (out[from] != null && out[to] == null) out[to] = out[from]!;
  }
  for (const k of REMOVED_V2_KEYS) delete out[k];
  out[SETTINGS_VERSION_KEY] = CURRENT_SETTINGS_VERSION;
  return out;
}

export interface KeyStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Every key the v1→v2 step can read or write — the only keys a store pass touches. */
const TOUCHED: readonly string[] = [...REMOVED_V2_KEYS, ...CARRY_V2.map(([, to]) => to)];

/** Convert one localStorage keyspace in place. `prefix` is "" (site) or "ov:"
 *  (the /chat window + OBS overlay). Returns true when it converted. */
export function migrateStore(store: KeyStore, prefix = ""): boolean {
  if (store.getItem(prefix + SETTINGS_VERSION_KEY) === CURRENT_SETTINGS_VERSION) return false;
  const before: Record<string, string> = {};
  for (const k of TOUCHED) {
    const v = store.getItem(prefix + k);
    if (v != null) before[k] = v;
  }
  const after = migrateSettingsBlob(before);
  for (const k of TOUCHED) {
    if (after[k] == null) { if (before[k] != null) store.removeItem(prefix + k); }
    else if (after[k] !== before[k]) store.setItem(prefix + k, after[k]!);
  }
  store.setItem(prefix + SETTINGS_VERSION_KEY, CURRENT_SETTINGS_VERSION);
  return true;
}

/** Behavior: the old "Reduced chat history" switch (`chatStyle_histReduced`)
 *  became Chat history length. Both the site and the /chat window read the old
 *  switch from the SITE key, so an ON there becomes Short in both keyspaces —
 *  unless that keyspace already picked a length. The old keys are then removed,
 *  so this runs once. Device-local, never synced. */
export function migrateHistLength(store: KeyStore): void {
  const was = store.getItem("chatStyle_histReduced");
  if (was === "1") {
    for (const p of ["", "ov:"]) {
      if (store.getItem(p + "chatStyle_histLength") == null) store.setItem(p + "chatStyle_histLength", "short");
    }
  }
  store.removeItem("chatStyle_histReduced");
  store.removeItem("ov:chatStyle_histReduced");
}
