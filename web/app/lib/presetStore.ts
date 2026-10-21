// The preset slots' store, shared by the settings menu (PresetSlots.tsx) and the terminal (its
// presets/N.conf files). One copy of:
// - the account's slots (site.setting_presets) with a signed-out / offline
//   fallback to this browser's own slots (localStorage),
// - the one-time, non-destructive import of a browser's slots into an EMPTY
//   account (once per browser, and only into an empty account — "Restore
//   house look" empties a slot on purpose, and every OTHER browser's old local
//   copy would upload it straight back),
// - save and clear, which never swallow their own failure (a swallowed PUT
//   shows as preset buttons that don't change colour when saved),
// - the house looks that fill empty slots.
// The "ov:" scope (/chat window, /overlay/chat OBS source) is device-local by
// design: local slots only, never the account, no house looks.
import { lsGet, lsSet, lsGetJSON, lsSetJSON, lsRemove } from "./safeLocalStorage";
import { settingsScope, isOverlayScope } from "./settingsRegistry";
import { getJson, postJsonOrThrow } from "./http";
import type { Look } from "./houseLooks";

export const PRESET_SLOTS = [1, 2, 3, 4] as const;
/** Scoped so the "ov:" pages' local preset slots are separate from the site's.
 *  @test-only exported for presetStore.test.ts, which seeds a browser slot by its key. */
export const presetKey = (n: number) => `${settingsScope()}bb_preset_${n}`;
/** Set once this browser has offered its local presets to the account. */
const importedKey = () => `${settingsScope()}bb_preset_imported`;

export type Preset = { slot: number; name: string | null; settings: Record<string, string> };
/** "local": overlay scope, signed-out, or offline — localStorage is the store. "account": site.setting_presets. */
export type PresetMode = "local" | "account";
export type Loaded = { mode: PresetMode; presets: Preset[]; filled: Record<number, boolean> };

const localBlob = (n: number): Record<string, string> | null => {
  const blob = lsGetJSON<Record<string, string> | null>(presetKey(n), null);
  return blob && typeof blob === "object" ? blob : null;
};

/** The browser's own slots: which are filled, and each as a nameless preset. */
function local(): Loaded {
  const filled: Record<number, boolean> = {};
  const presets: Preset[] = [];
  for (const n of PRESET_SLOTS) {
    const blob = localBlob(n);
    filled[n] = !!blob;
    if (blob) presets.push({ slot: n, name: null, settings: blob });
  }
  return { mode: "local", presets, filled };
}

/** Your slots: the account's when signed in (importing this browser's once, into an empty account), else the browser's. */
export async function loadPresets(): Promise<Loaded> {
  if (isOverlayScope()) return local();
  let fetched: Preset[];
  try {
    ({ presets: fetched } = await getJson<{ presets: Preset[] }>("/api/me/presets"));
  } catch {
    // Signed-out (401) or offline — the browser's slots.
    return local();
  }
  const importNow = fetched.length === 0 && !lsGet(importedKey());
  const known = new Set(fetched.map((p) => p.slot));
  const imported: Preset[] = [];
  for (const n of importNow ? PRESET_SLOTS.filter((s) => !known.has(s)) : []) {
    const blob = localBlob(n);
    if (!blob) continue;
    try {
      const { preset } = await postJsonOrThrow<{ preset: Preset }>("/api/me/presets", { slot: n, settings: blob }, "PUT");
      imported.push(preset);
    } catch { /* best effort — the local copy still stands, retried next load */ }
  }
  lsSet(importedKey(), "1");
  const presets = [...fetched, ...imported];
  const filled: Record<number, boolean> = {};
  for (const n of PRESET_SLOTS) filled[n] = presets.some((p) => p.slot === n);
  return { mode: "account", presets, filled };
}

/** Save `settings` (a look blob, storage names) into slot `n`; `name` renames it. Throws when the account refused. */
export async function savePreset(mode: PresetMode, n: number, settings: Record<string, string>, name?: string | null): Promise<Preset> {
  if (mode === "account") {
    const body: Record<string, unknown> = { slot: n, settings };
    if (name != null) body.name = name;
    const { preset } = await postJsonOrThrow<{ preset: Preset }>("/api/me/presets", body, "PUT");
    return preset;
  }
  lsSetJSON(presetKey(n), settings);
  return { slot: n, name: null, settings };
}

/** Remove your look from slot `n` (the account's and this browser's copy). Throws when the account refused. */
export async function clearPreset(mode: PresetMode, n: number): Promise<void> {
  if (mode === "account") await postJsonOrThrow(`/api/me/presets?slot=${n}`, undefined, "DELETE");
  lsRemove(presetKey(n));
}

/** The site's house looks by slot. Public, so signed-out viewers get them too; a failed fetch is none. */
export async function loadHouseLooks(): Promise<Record<number, Look>> {
  try {
    const { looks } = await getJson<{ looks: (Look & { slot: number })[] }>("/api/house-looks");
    const byslot: Record<number, Look> = {};
    for (const l of looks) byslot[l.slot] = { name: l.name, settings: l.settings };
    return byslot;
  } catch {
    return {};
  }
}

export type SlotFile = { slot: number; own: boolean; name: string | null; settings: Record<string, string>; houseBehind: boolean };

/** Each slot as a file: your own look, else the house look filling it, else no file. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function slotFiles(presets: readonly Preset[], house: Record<number, Look>): SlotFile[] {
  const out: SlotFile[] = [];
  for (const n of PRESET_SLOTS) {
    const own = presets.find((p) => p.slot === n);
    const h = house[n];
    if (own) out.push({ slot: n, own: true, name: own.name, settings: own.settings, houseBehind: !!h });
    else if (h) out.push({ slot: n, own: false, name: h.name, settings: h.settings, houseBehind: true });
  }
  return out;
}
