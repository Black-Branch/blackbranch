import type { EmoteMap } from "./emoteMap";
import { scoreEmoteMatch } from "./emoteTriggerLogic";
import { getRecentEmotes } from "./recentEmotes";

// Pure ranking logic, no UI. Lives in core because lib/useEmoteAutocomplete.ts
// drives the autocomplete and must not import the component that renders the
// list (dependency direction). EmoteCompletionList re-exports it, so existing
// imports from the component are unchanged.
//
// NOTE: this is a MOVE, not a split — the hook and its ranking stay one unit,
// they just both live in core now.

// Ranked emote matches — the Chatterino/DankChat cost model (scoreEmoteMatch):
// shorter/closer matches first, exact-case pinned, frequently used emotes boosted
// (-50, same frecency store the picker's Frequent row uses). Ties: prefix matches
// before mid-word, then alpha. An empty ':' query lists the frecent emotes first
// (strongest frecency first), then the rest alpha.
export function getEmoteMatches(
  query: string,
  emotes: EmoteMap,
  zeroWidthOnly: boolean,
): Array<[string, string | null]> {
  const entries = Object.entries(emotes).filter(([, info]) => !zeroWidthOnly || info.zeroWidth);
  const q = query.toLowerCase();

  if (!q) {
    const recent = getRecentEmotes(emotes).filter((n) => !zeroWidthOnly || emotes[n]?.zeroWidth);
    const recentSet = new Set(recent);
    const rest = entries
      .filter(([n]) => !recentSet.has(n))
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return [
      ...recent.map((n): [string, string | null] => [n, emotes[n]?.url ?? null]),
      ...rest.map(([n, i]): [string, string | null] => [n, i.url]),
    ].slice(0, 200);
  }

  const recentSet = new Set(getRecentEmotes(emotes));
  const scored: Array<{ name: string; url: string; score: number; prefix: boolean }> = [];
  for (const [name, info] of entries) {
    const base = scoreEmoteMatch(name, query);
    if (base === null) continue;
    scored.push({
      name,
      url: info.url,
      score: base + (recentSet.has(name) ? -50 : 0),
      prefix: name.toLowerCase().startsWith(q),
    });
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    Number(b.prefix) - Number(a.prefix) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
  return scored.slice(0, 200).map((s): [string, string | null] => [s.name, s.url]);
}
