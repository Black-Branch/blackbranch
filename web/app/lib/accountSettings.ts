// The ONE place a page pulls the account's saved settings into localStorage
// (SettingsHydrator and ChatSettings both call it). Converts every blob
// to the current layout on the way (settingsMigrate.ts).
import { SETTING_KEYS, ENTRIES, isOverlayScope } from "./settingsRegistry";
import { lsSet } from "./safeLocalStorage";
import { getJson } from "./http";
import { deviceClass } from "./deviceClass";
import { migrateSettingsBlob, migrateStore, migrateHistLength, SETTINGS_VERSION_KEY } from "./settingsMigrate";

export async function pullAccountSettings(): Promise<{ authed: boolean }> {
  // Both local keyspaces, SITE FIRST: the ov: keyspace lazily seeds from the
  // site one on read, so converting the site first means a seed can only ever
  // copy a v2 key.
  try {
    migrateStore(window.localStorage, "");
    migrateStore(window.localStorage, "ov:");
    migrateHistLength(window.localStorage);
  } catch { /* storage blocked — nothing local to convert */ }

  // The ov: scope is device-local by design: never pull the account blob there.
  if (isOverlayScope()) return { authed: false };
  try {
    const { settings, authed } = await getJson<{ settings?: Record<string, unknown>; authed?: boolean }>(
      `/api/me/settings?device_class=${deviceClass()}`,
    );
    if (settings && typeof settings === "object") {
      const blob = migrateSettingsBlob(settings);
      for (const key of SETTING_KEYS) {
        const v = blob[ENTRIES[key].ls];
        if (v != null) lsSet(ENTRIES[key].ls, v);
      }
      if (blob.chatUsernameColor != null) lsSet("chatUsernameColor", blob.chatUsernameColor);
      lsSet(SETTINGS_VERSION_KEY, blob[SETTINGS_VERSION_KEY]!);
    }
    return { authed: !!authed };
  } catch {
    return { authed: false }; // offline / signed-out — local settings stand
  }
}
