// The persisted chat/appearance settings keys — the single list used to export
// localStorage → DB and hydrate DB → localStorage (see /api/me/settings and the
// ChatSettings hydrate). Derived from the settings registry so it can never drift
// from the actual controls.
//
// Scope: durable look-and-feel ("my config"). Device/session-local UI state
// (chatWidth, panelMode, dismissedPinId, recentEmotes, welcomeSeen) is
// deliberately excluded — it shouldn't follow you across devices.
//
// `chatUsernameColor` is sync-only (no ChatSettings control — it's set from the
// profile color picker and read by ChatMessage), so it's appended explicitly.
//
// All values are stored as strings (their localStorage form) inside the JSONB blob.
import { ENTRIES, SETTING_KEYS, settingGet } from "./settingsRegistry";
import { migrateSettingsBlob, SETTINGS_VERSION_KEY } from "./settingsMigrate";

const SETTINGS_KEYS: string[] = [
  // Registry entries flagged `deviceLocal` are excluded — they shouldn't follow
  // the account across devices (e.g. auto-suggest emotes: off desktop, on mobile).
  ...SETTING_KEYS.filter((k) => !ENTRIES[k].deviceLocal).map((k) => ENTRIES[k].ls),
  "chatUsernameColor",
  // The layout stamp (settingsMigrate.ts) rides with the blob so a converted
  // account is never converted twice.
  SETTINGS_VERSION_KEY,
];

const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS);

// Whitelist an incoming settings blob to known keys and coerce values to
// strings — never persist arbitrary client-supplied JSON. Values are length-
// capped defensively. Shared by the /api/me/settings and /api/me/presets PUT
// routes so the two can't drift.
export function sanitizeSettingsBlob(incoming: Record<string, unknown>): Record<string, string> {
  // Convert BEFORE whitelisting: a tab still running pre-deploy code sends v1
  // keys, and the v2 whitelist would drop them — silently resetting that
  // viewer's panel colours.
  const migrated = migrateSettingsBlob(incoming);
  const clean: Record<string, string> = {};
  for (const [k, s] of Object.entries(migrated)) {
    if (!SETTINGS_KEY_SET.has(k)) continue;
    if (s.length > 256) continue;
    clean[k] = s;
  }
  return clean;
}

// The ls names of Behavior settings — never part of a saved look.
const BEHAVIOR_LS = new Set(SETTING_KEYS.filter((k) => ENTRIES[k].behavior).map((k) => ENTRIES[k].ls));

/** collectLocalSettings() without Behavior: what a preset slot saves. */
export function collectLookSettings(): Record<string, string> {
  const out = collectLocalSettings();
  for (const k of Object.keys(out)) if (BEHAVIOR_LS.has(k)) delete out[k];
  return out;
}

// Read the persisted settings out of localStorage into a plain object.
export function collectLocalSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === "undefined") return out;
  // Scope-aware: on the "ov:" pages (/chat, /overlay/chat) this reads the isolated keyspace, so
  // preset snapshots taken there capture the overlay's look (not the site's).
  for (const k of SETTINGS_KEYS) {
    const v = settingGet(k);
    if (v != null) out[k] = v;
  }
  return out;
}
