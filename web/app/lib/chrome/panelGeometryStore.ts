// localStorage persistence for the chrome Window's floating-panel geometry. Split out
// of panelGeometry.ts (see that file's header) so the clamp math stays testable
// under node --test without a DOM.

import { lsGet, lsSet } from "../safeLocalStorage";
import { parseGeom, type StoredGeom } from "./panelGeometry";

/** Read a persisted geometry, or `null` if absent/corrupt (validation lives in
 *  parseGeom, which is pure and node-tested). */
export function loadGeom(storageKey: string): StoredGeom | null {
  return parseGeom(lsGet(storageKey));
}

export function saveGeom(storageKey: string, g: StoredGeom): void {
  lsSet(storageKey, JSON.stringify(g));
}
