"use client";
// Behavior — the ONE browser copy of the viewer's Behavior lists (hidden
// people, highlighted words; rules in behaviorLists.ts). Every reader — the chat
// lists, the Behavior menu, the name card, /ignore — shares it, so hiding someone
// anywhere hides them everywhere at once.
//
// Signed in: loaded from and saved to /api/me/behavior (site.user_behavior), so
// the lists follow the account to every device. Signed out (the route answers
// 401): this browser only, in localStorage.
//
// Two ways this could silently WIPE someone's lists, both closed:
//  • Saving before a load has succeeded. The PUT replaces both lists, so a save
//    from the empty placeholder erases the account. A change is only ever applied
//    to lists that were actually read, and a failed load is retried, not cached.
//  • A stale tab. The phone hides X; a desktop tab opened an hour ago adds a
//    word and PUTs its old copy, un-hiding X. So every change re-reads the
//    account's current lists first and applies itself to THAT, and a tab that
//    becomes visible again re-reads too.
import { useSyncExternalStore } from "react";
import {
  EMPTY_LISTS, sanitizeLists, addHidden, removeHidden, setWords, MAX_HIDDEN,
  type BehaviorLists,
} from "./behaviorLists";
import { lsGet, lsSet, lsRemove } from "./safeLocalStorage";
import { migrateLegacyLocal, reHideNotice } from "./behaviorLegacyLocal";

const LOCAL_KEY = "bb_behavior_lists";
// Names from an old-shaped browser list, waiting to be shown once (behaviorLegacyLocal.ts).
// In storage, not memory, so a page with no chat box to show it does not lose it.
const REHIDE_KEY = "bb_behavior_rehide";

let lists: BehaviorLists = EMPTY_LISTS;
let mode: "unknown" | "account" | "local" = "unknown";
let loading: Promise<boolean> | null = null;
let visibilityArmed = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

function readLocal(): BehaviorLists {
  let stored: BehaviorLists;
  try { stored = sanitizeLists(JSON.parse(lsGet(LOCAL_KEY) ?? "null")); } catch { return EMPTY_LISTS; }
  // A list from before chat lines carried public ids: keep what is safe, write it
  // back so this happens once, and queue the one-time "hide them again" notice.
  const { lists: migrated, reHide } = migrateLegacyLocal(stored);
  if (reHide) {
    lsSet(LOCAL_KEY, JSON.stringify(migrated));
    lsSet(REHIDE_KEY, JSON.stringify(reHide));
  }
  return migrated;
}

/** The one-time notice for a signed-out list that held old-shaped entries, or null.
 *  Taking it clears it. */
export async function takeReHideNotice(): Promise<string | null> {
  await load();
  const raw = lsGet(REHIDE_KEY);
  if (!raw) return null;
  lsRemove(REHIDE_KEY);
  try {
    const names = JSON.parse(raw) as unknown;
    return Array.isArray(names) && names.length > 0 ? reHideNotice(names.map(String)) : null;
  } catch { return null; }
}

/** Read the lists from where they live. true = `lists`/`mode` now reflect it. */
async function fetchLists(): Promise<boolean> {
  try {
    const r = await fetch("/api/me/behavior", { cache: "no-store" });
    if (r.status === 401) { mode = "local"; lists = readLocal(); emit(); return true; }
    if (r.ok) {
      mode = "account";
      lists = sanitizeLists(((await r.json()) as { lists?: unknown }).lists);
      emit();
      return true;
    }
  } catch { /* offline */ }
  return false;
}

/** Load once; a FAILED load is forgotten so the next caller tries again. */
function load(): Promise<boolean> {
  loading ??= fetchLists().then((ok) => { if (!ok) loading = null; return ok; });
  return loading;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  void load();
  if (!visibilityArmed && typeof document !== "undefined") {
    visibilityArmed = true;
    // Another device may have changed the lists while this tab sat in the background.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && mode !== "unknown") void fetchLists();
    });
  }
  return () => { listeners.delete(cb); };
}

/** The viewer's Behavior lists; re-renders when they change. */
export function useBehaviorLists(): BehaviorLists {
  return useSyncExternalStore(subscribe, () => lists, () => EMPTY_LISTS);
}

/** True once the ACCOUNT's lists have loaded — the Matrix ignore sync must never
 *  run on the empty placeholder (it would take the site's ignores back off). */
export function accountListsLoaded(): boolean { return mode === "account"; }

/** The lists as they are now, for code outside React (the /unignore command). */
export async function currentLists(): Promise<BehaviorLists> { await load(); return lists; }

/** Apply one change to the CURRENT stored lists and save the result. false = the
 *  lists could not be read or saved (what is shown is re-read from the server). */
async function change(fn: (l: BehaviorLists) => BehaviorLists | null): Promise<boolean> {
  // Fresh read first (not the page-load copy) — see the stale-tab note above.
  if (!(await fetchLists())) return false;
  const next = fn(lists);
  if (!next) return true;
  lists = next;
  emit();
  if (mode === "local") { lsSet(LOCAL_KEY, JSON.stringify(next)); return true; }
  try {
    const r = await fetch("/api/me/behavior", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
    });
    if (r.status === 401) { mode = "local"; lsSet(LOCAL_KEY, JSON.stringify(next)); return true; }
    if (r.ok) return true;
  } catch { /* fall through */ }
  await fetchLists();
  return false;
}

export type HideResult = "hidden" | "self" | "already" | "full" | "failed";

/** Hide a person everywhere. A site account also lands on the Matrix ignore list
 *  (useHiddenIgnoreSync), so Community and Element hide them too. */
export async function hidePerson(
  p: { id: string; name: string; matrixId?: string | null },
  me: { ownIds?: readonly string[] | null; matrixId?: string | null },
): Promise<HideResult> {
  if ((me.ownIds && me.ownIds.includes(p.id)) || (me.matrixId && (p.matrixId === me.matrixId || p.id === me.matrixId))) return "self";
  let why: HideResult = "hidden";
  const ok = await change((l) => {
    if (l.hidden.some((h) => h.id === p.id)) { why = "already"; return null; }
    if (l.hidden.length >= MAX_HIDDEN) { why = "full"; return null; }
    return addHidden(l, p, me);
  });
  return ok ? why : "failed";
}

/** Unhide a person (the ignore sync takes a site account off the Matrix list). */
export async function unhidePerson(id: string): Promise<boolean> {
  return change((l) => (l.hidden.some((h) => h.id === id) ? removeHidden(l, id) : null));
}

/** Change the words, as a function of the CURRENT stored ones (never a stale copy). */
export async function setHighlightWords(update: (words: readonly string[]) => readonly string[]): Promise<boolean> {
  return change((l) => setWords(l, update(l.words)));
}
