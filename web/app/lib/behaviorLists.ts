// Behavior — the lists that follow the ACCOUNT on every device: hidden people
// and highlighted words. Stored in site.user_behavior for a signed-in viewer,
// in this browser only for a signed-out one.
//
// This file is the one set of RULES — the API route cleans what it stores with
// it, the browser cleans what it loads and matches messages with it.
// PURE and import-free: node --test imports it directly.

/** A hidden person. `id` is the id the chat line carried: a site account's Matrix id, else the
 *  sender's per-platform PUBLIC id (stable across name changes; one platform — a viewer cannot tell
 *  a person's other platforms, so hiding them there is a separate choice). `name` is only what the
 *  list shows; `matrixId` (site accounts) also goes on the Matrix ignore list so Community hides
 *  them too. */
export type HiddenPerson = { id: string; name: string; matrixId: string | null };

/** The shape of a canonical stream id (12 hex). Lists saved before chat lines carried public ids
 *  hold some; /api/me/behavior rewrites the STORED ones once and refuses new ones (a list that
 *  accepted a canonical would translate a stranger's into their platforms on read). */
export function isLegacyCanonicalId(id: string): boolean {
  return /^[0-9a-f]{12}$/.test(id);
}
export type BehaviorLists = { hidden: HiddenPerson[]; words: string[] };

export const MAX_HIDDEN = 500;
export const MAX_WORDS = 30;
export const MAX_WORD_LEN = 40;
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 64;

export const EMPTY_LISTS: BehaviorLists = { hidden: [], words: [] };

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;

function cleanWords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const w of input) {
    if (typeof w !== "string") continue;
    const t = w.trim().toLowerCase();
    if (!t || t.length > MAX_WORD_LEN || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_WORDS) break;
  }
  return out;
}

/** Whatever came in (a request body, localStorage), as valid lists. Never throws. */
export function sanitizeLists(input: unknown): BehaviorLists {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const hidden: HiddenPerson[] = [];
  const seen = new Set<string>();
  for (const h of Array.isArray(o.hidden) ? o.hidden : []) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    const id = str(r.id, MAX_ID_LEN);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // A long display name is CUT, not refused — refusing would show a raw id in the list
    // and leave /unignore <name> unable to find them.
    const name = typeof r.name === "string" && r.name.trim() ? r.name.slice(0, MAX_NAME_LEN) : id;
    hidden.push({ id, name, matrixId: str(r.matrixId, MAX_ID_LEN) });
    if (hidden.length === MAX_HIDDEN) break;
  }
  return { hidden, words: cleanWords(o.words) };
}

/** A predicate: was this message sent by someone on the hidden list? */
export function hiddenMatcher(lists: BehaviorLists): (m: { publicId?: string | null; matrixId?: string | null }) => boolean {
  if (lists.hidden.length === 0) return () => false;
  const ids = new Set(lists.hidden.map((h) => h.id));
  const mx = new Set(lists.hidden.map((h) => h.matrixId).filter((x): x is string => !!x));
  return (m) => (!!m.publicId && ids.has(m.publicId)) || (!!m.matrixId && (mx.has(m.matrixId) || ids.has(m.matrixId)));
}

/** Add a person. null = refused (it is you, or already listed). */
export function addHidden(
  lists: BehaviorLists,
  p: { id: string; name: string; matrixId?: string | null },
  me: { ownIds?: readonly string[] | null; matrixId?: string | null },
): BehaviorLists | null {
  if ((me.ownIds && me.ownIds.includes(p.id)) || (me.matrixId && (p.matrixId === me.matrixId || p.id === me.matrixId))) return null;
  if (lists.hidden.some((h) => h.id === p.id)) return null;
  return sanitizeLists({ ...lists, hidden: [...lists.hidden, { ...p, matrixId: p.matrixId ?? null }] });
}

export function removeHidden(lists: BehaviorLists, id: string): BehaviorLists {
  return { ...lists, hidden: lists.hidden.filter((h) => h.id !== id) };
}

export function setWords(lists: BehaviorLists, words: readonly string[]): BehaviorLists {
  return { ...lists, words: cleanWords(words) };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A predicate: does this text contain one of the words, as a whole word/phrase
 *  in any case? Letters/digits on either side break a match ("tacosalad"); any
 *  other character (space, punctuation, "+") does not ("C++ daily"). */
export function wordsMatcher(words: readonly string[]): (text: string) => boolean {
  if (words.length === 0) return () => false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(esc).join("|")})(?![\\p{L}\\p{N}_])`, "iu");
  return (text) => re.test(text);
}
