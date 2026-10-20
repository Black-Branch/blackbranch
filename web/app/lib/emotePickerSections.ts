// Headless section/tab builder for EmotePicker. Extracted so the placement
// rules are unit-testable without mounting the portal picker:
//   • the personal set is included but NEVER sorted to the top;
//   • "channel emotes" = emotes owned by ANY specific Twitch channel — grouped
//     per channel, each under its own channel-name divider — and Twitch
//     GLOBALS are the non-channel group at the very bottom. The Twitch tab
//     carries all of it (site channel + every personal channel group + globals).
// Empty sections are omitted here, not hidden by the component, so the label
// sequence IS the rendered sequence.

import type { EmoteMap } from "./emoteMap";
import { emoteQuery } from "./emoteSearch.ts";
import { groupPersonalEntries } from "./personalEmotes.ts";

export type PickerCategory = "all" | "7tv" | "bttv" | "twitch" | "ffz" | "mine";
type Provider = Exclude<PickerCategory, "all" | "mine">;
export type PickerSection = { key: string; label: string | null; items: Array<[string, string]> };

// Labels when a name is missing — neutral nouns, never a hardcoded owner name
// (no owner hardcoding).
const CHANNEL_LABEL_FALLBACK = "Channel emotes";
const OTHER_CHANNELS_LABEL = "Other channels";
const GLOBALS_LABEL = "Twitch globals";

function detectProvider(url: string): Provider {
  if (url.includes("cdn.7tv.app")) return "7tv";
  if (url.includes("cdn.betterttv.net")) return "bttv";
  if (url.includes("jtvnw.net")) return "twitch";
  return "ffz";
}

export function buildPickerData(args: {
  emotes: EmoteMap;      // the site catalog — NOT the merged input map
  personal: EmoteMap;
  recent: string[];
  tab: PickerCategory;
  search: string;
  /** Channel name labeling the SITE channel's group (from /api/emotes/meta). */
  channelLabel: string | null;
}): { sections: PickerSection[]; tabs: PickerCategory[] } {
  const { emotes, personal, recent, tab, search, channelLabel } = args;
  const byCat: Record<Provider, Array<[string, string]>> = { "7tv": [], bttv: [], twitch: [], ffz: [] };
  for (const [name, info] of Object.entries(emotes)) byCat[detectProvider(info.url)].push([name, info.url]);
  (Object.keys(byCat) as Provider[]).forEach((k) =>
    byCat[k].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
  );
  // The catalog's ONLY Twitch emotes are the channel set (the manifest excludes
  // Twitch globals by decision), so byCat.twitch IS the site channel's group.
  const rest = [...byCat["7tv"], ...byCat.bttv, ...byCat.ffz].sort(([a], [b]) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const groups = groupPersonalEntries(emotes, personal);
  const chanLabel = channelLabel ?? CHANNEL_LABEL_FALLBACK;

  // A personal emote owned by the SITE channel belongs in the site channel's
  // group, not a duplicate group of the same name below it.
  const siteChannelExtras =
    channelLabel === null
      ? []
      : groups.channels.find(([c]) => c.toLowerCase() === channelLabel.toLowerCase())?.[1] ?? [];
  const channel = [...byCat.twitch, ...siteChannelExtras].sort(([a], [b]) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const otherChannels =
    channelLabel === null
      ? groups.channels
      : groups.channels.filter(([c]) => c.toLowerCase() !== channelLabel.toLowerCase());
  const all = [...channel, ...rest];

  const tabs: PickerCategory[] = (["all", "7tv", "bttv", "twitch", "ffz"] as PickerCategory[]).filter(
    (t) =>
      t === "all" ||
      // The Twitch tab hosts the personal set too (r2), so it exists whenever
      // EITHER does.
      (t === "twitch" ? channel.length + groups.count > 0 : (byCat[t as Provider]?.length ?? 0) > 0)
  );
  if (groups.count > 0) tabs.push("mine"); // trailing chip — never leads (r1)

  const q = emoteQuery(search);
  const match = (list: Array<[string, string]>) => (q ? list.filter(([n]) => n.toLowerCase().includes(q)) : list);
  const nonEmpty = (sections: PickerSection[]) => sections.filter((s) => s.items.length > 0);

  // The personal set as sections: one per channel (its login is the divider),
  // then unresolved owners, then Twitch globals LAST (the r2 correction).
  const personalSections = (transform: (l: Array<[string, string]>) => Array<[string, string]>) =>
    nonEmpty([
      ...otherChannels.map(([c, list]): PickerSection => ({ key: `pch:${c}`, label: c, items: transform(list) })),
      { key: "pch-other", label: OTHER_CHANNELS_LABEL, items: transform(groups.other) },
      { key: "pch-globals", label: GLOBALS_LABEL, items: transform(groups.globals) },
    ]);

  if (tab === "mine") return { sections: personalSections(match), tabs };
  if (tab === "twitch") {
    return {
      sections: [
        ...nonEmpty([{ key: "twitch-channel", label: chanLabel, items: match(channel) }]),
        ...personalSections(match),
      ],
      tabs,
    };
  }
  if (tab !== "all") return { sections: [{ key: tab, label: null, items: match(byCat[tab as Provider] ?? []) }], tabs };
  if (q) {
    // Search is a lookup, not browsing — one flat catalog result list, with
    // the personal matches kept separate below it (r1).
    const flatPersonal = [...otherChannels.flatMap(([, l]) => l), ...groups.other, ...groups.globals]
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const sections: PickerSection[] = nonEmpty([
      { key: "results", label: null, items: match(all) },
      { key: "mine", label: "Your emotes", items: match(flatPersonal) },
    ]);
    return { sections, tabs };
  }
  const recentItems = recent
    .map((n) => [n, emotes[n]?.url ?? personal[n]?.url] as [string, string | undefined])
    .filter((e): e is [string, string] => Boolean(e[1]));
  const recentSet = new Set(recentItems.map(([n]) => n));
  const noRecent = (list: Array<[string, string]>) => list.filter(([n]) => !recentSet.has(n));
  return {
    sections: [
      ...(recentItems.length ? [{ key: "recent", label: "Frequent", items: recentItems }] : []),
      ...nonEmpty([
        { key: "twitch-channel", label: chanLabel, items: noRecent(channel) },
        { key: "main", label: null, items: noRecent(rest) },
      ]),
      ...personalSections(noRecent),
    ],
    tabs,
  };
}
