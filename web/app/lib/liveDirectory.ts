"use client";
// The site chat's current "who is here" directory (chatDirectory.ts) and the
// viewer's own ids, shared so places OUTSIDE the chat list — the Behavior menu's
// "+ hide someone" field and /ignore — can turn a typed name into a person and
// refuse the viewer themselves. ChatSidebar publishes both; readers take a
// snapshot when they need one. Null / empty until a chat list has mounted.
import type { ChatDirectory } from "./chatDirectory";

// `ownIds`: the viewer's own per-platform public ids (ownIdentity.ts) — what "is this me?" compares.
type Viewer = { matrixId: string | null; canonicalId: string | null; ownIds?: readonly string[] };
let current: ChatDirectory | null = null;
let viewer: Viewer = { matrixId: null, canonicalId: null, ownIds: [] };

export function publishLiveDirectory(dir: ChatDirectory | null, me?: Viewer): void {
  current = dir;
  if (me) viewer = me;
}
export function liveDirectory(): ChatDirectory | null { return current; }
export function liveViewer(): Viewer { return viewer; }
