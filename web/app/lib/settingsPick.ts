// The "applied preset" marker: which slot the current look came from, and
// whether something changed since. Kept per browser and per scope, so the
// "selected" colour survives closing the menu.
// One copy: the settings menu reads it at mount and writes its state back; the
// terminal's `set` of a look setting marks it edited, and a preset applied
// through the terminal's config folder sets it.
import { lsGetJSON, lsSetJSON, lsRemove } from "./safeLocalStorage";
import { settingsScope } from "./settingsRegistry";

export type Pick = { slot: number; edited: boolean };
/** @test-only exported for settingsPick.test.ts and settingsPresets.test.ts, which pin the key's name. */
export const PICK_KEY = () => `${settingsScope()}bb_preset_sel`;

export function readPick(): Pick | null {
  const p = lsGetJSON<Pick | null>(PICK_KEY(), null);
  return p && Number.isInteger(p.slot) && p.slot >= 1 && p.slot <= 4
    ? { slot: p.slot, edited: p.edited === true } : null;
}

export function writePick(pick: Pick | null): void {
  if (pick) lsSetJSON(PICK_KEY(), pick); else lsRemove(PICK_KEY());
}

/** The settings no longer match the preset they came from: it stays the pick, edited. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function markPickEdited(): void {
  const p = readPick();
  if (p && !p.edited) writePick({ ...p, edited: true });
}
