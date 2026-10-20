// Pure collision/merge policy for personal Twitch emotes.
// THE rule lives here and in the spread order below, nowhere else: the site
// catalog wins every name collision (everyone has access to the site
// catalog). resolveOutgoingEmotes enforces it for viewers (a colliding name
// never enters the per-message map); mergeForInput enforces it for the
// sender's own input surfaces (global spread last).

import type { EmoteMap } from "./emoteMap";

/** Build the per-message map for an outgoing native message: every
 *  whitespace-separated word that is one of the SENDER's personal emotes and
 *  not a site-catalog name. Null when empty so callers can omit the field. */
export function resolveOutgoingEmotes(
  message: string,
  personal: EmoteMap,
  globalNames: ReadonlySet<string>
): Record<string, string> | null {
  let out: Record<string, string> | null = null;
  for (const word of message.split(/\s+/)) {
    if (!word || globalNames.has(word)) continue;
    const info = personal[word];
    if (info) (out ??= {})[word] = info.url;
  }
  return out;
}

/** Input-surface map (autocomplete + picker grid): personal first, global
 *  last, so a colliding name resolves to the site catalog's emote. */
export function mergeForInput(global: EmoteMap, personal: EmoteMap): EmoteMap {
  return { ...personal, ...global };
}

export type PersonalGroups = {
  /** [channelLogin, entries] — channels alpha, entries alpha within each. */
  channels: Array<[string, Array<[string, string]>]>;
  /** Channel-owned but the owner lookup failed (ch: "") — "Other channels". */
  other: Array<[string, string]>;
  /** Twitch globals (ch: null) — also where v1 cache entries without a `ch`
   *  key land, transiently, until the server's staleness refresh replaces
   *  them (isPersonalCacheStale). */
  globals: Array<[string, string]>;
  /** Total non-colliding entries — drives the Mine/Twitch tab existence. */
  count: number;
};

/** The picker's personal-set structure: personal names the catalog doesn't
 *  already carry, grouped by owning channel, with Twitch globals split off to
 *  render at the bottom. */
export function groupPersonalEntries(global: EmoteMap, personal: EmoteMap): PersonalGroups {
  const byChannel = new Map<string, Array<[string, string]>>();
  const other: Array<[string, string]> = [];
  const globals: Array<[string, string]> = [];
  let count = 0;
  for (const [name, info] of Object.entries(personal)) {
    if (name in global) continue; // catalog wins (r1)
    count++;
    const ch = info.ch ?? null;
    if (ch === null) globals.push([name, info.url]);
    else if (ch === "") other.push([name, info.url]);
    else {
      const list = byChannel.get(ch) ?? [];
      list.push([name, info.url]);
      byChannel.set(ch, list);
    }
  }
  const alpha = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  const byName = (list: Array<[string, string]>) => list.sort(([a], [b]) => alpha(a, b));
  return {
    channels: [...byChannel.entries()]
      .sort(([a], [b]) => alpha(a, b))
      .map(([c, list]): [string, Array<[string, string]>] => [c, byName(list)]),
    other: byName(other),
    globals: byName(globals),
    count,
  };
}
