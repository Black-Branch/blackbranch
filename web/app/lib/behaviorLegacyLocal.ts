// A signed-out browser's hidden-people list saved before chat lines carried public
// ids holds canonical ids (12 hex), which no line carries any more — so those
// people stopped being hidden. A signed-in account's list is rewritten by the
// server (/api/me/behavior); a signed-out one cannot be: nothing may translate a
// canonical id into public ids for a browser (it would de-anonymise them).
//
// What CAN be kept safely: an entry that also recorded a site account's Matrix id
// becomes that account's entry (a site account's entry is keyed by its Matrix id
// anyway), so their site lines stay hidden. Everything else is dropped. Either way
// the viewer is told once, by name, so they can hide those people again.
//
// PURE — node --test imports it.
import { isLegacyCanonicalId, sanitizeLists, type BehaviorLists } from "./behaviorLists.ts";

/** The migrated lists, and the names of everyone who needs hiding again (null = nothing old). */
export function migrateLegacyLocal(lists: BehaviorLists): { lists: BehaviorLists; reHide: string[] | null } {
  const legacy = lists.hidden.filter((h) => isLegacyCanonicalId(h.id));
  if (legacy.length === 0) return { lists, reHide: null };
  const next = sanitizeLists({
    ...lists,
    hidden: lists.hidden.flatMap((h) => (!isLegacyCanonicalId(h.id) ? [h]
      : h.matrixId ? [{ id: h.matrixId, name: h.name, matrixId: h.matrixId }]
      : [])),
  });
  return { lists: next, reHide: legacy.map((h) => h.name) };
}

/** The one-time notice for those names. */
export function reHideNotice(names: readonly string[]): string {
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
  return `After an update, some people you hid on this browser are no longer hidden everywhere: ${shown}. ` +
    "Hide them again from one of their messages.";
}
