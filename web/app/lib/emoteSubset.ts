import type { EmoteMap } from "./emoteMap.ts";

// The emotes a set of rows can render, cut from the full manifest — what a
// server page inlines so the seeded rows carry their emote <img>s in the HTML
// and the browser fetches them before any script runs. The
// whole manifest is ~130 KB (over a thousand emotes); the rows on
// screen use a few dozen at most.
//
// A SUPERSET of what the renderer resolves, by construction: renderText can
// only match an emote whose name appears verbatim in the text (lineTokens'
// split, the adjacent-emote split, the mixed split — every one a substring
// match, case-sensitive), so "does the name occur in the text" cannot miss
// one. It may include a name that occurs inside a word the renderer leaves as
// text; that costs a few hundred bytes, never a missing emote.
//
// `.ts` extension on the import: this module is exercised under node --test.
export function emotesUsedBy(texts: Iterable<string>, manifest: EmoteMap): EmoteMap {
  let all = "";
  for (const t of texts) if (t) all += t + "\n";
  const out: EmoteMap = {};
  if (all.length === 0) return out;
  for (const name in manifest) {
    if (all.includes(name)) out[name] = manifest[name]!;
  }
  return out;
}
