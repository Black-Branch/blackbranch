"use client";

import type { EmoteInfo, EmoteMap } from "./emoteMap";
import { emoteCrossOrigin, emoteSizingKey, pickerEmoteUrl } from "./emoteRes";
import { buildPickerData } from "./emotePickerSections";
import { getRecentEmotes } from "./recentEmotes";
import { mergeForInput } from "./personalEmotes";
import { settingGet } from "./settingsRegistry";

// The emote picker opens with nothing loading in — waiting for each tile to
// load in feels sloppy next to a picker that paints thousands at once. Two
// halves:
//   • here — the INTENT preload: the moment a person reaches for the picker (hover,
//     focus or press on the emote button, focus in the message field) the first
//     PICKER_EAGER tiles of the default tab are fetched AND decoded, and the decoded
//     images are held, so the picker's first frame paints them;
//   • EmotePicker — renders those same tiles eagerly and looks ahead of the scroll
//     for the rest.
// Both use pickerTileSrc, which is the chat's own URL at default settings — after
// the background warm (emoteWarmer.ts) this is decode-only, no network.

/** Tiles rendered with their image at once (≈ the first two screens of the grid). */
export const PICKER_EAGER = 70;

export function pickerTileSrc(info: Pick<EmoteInfo, "url" | "still" | "h">, still: boolean): string {
  return pickerEmoteUrl(still && info.still ? info.still : info.url, info.h);
}

// Decoded and held for the page's life (≤ PICKER_EAGER small images per display size).
const held = new Map<string, HTMLImageElement>();

// Hover fires often; the work is redone only when its inputs change.
let last: { emotes: EmoteMap; personal: EmoteMap; key: string } | null = null;

export function preparePicker(emotes: EmoteMap, personal: EmoteMap): void {
  if (typeof window === "undefined") return;
  const still = settingGet("chatStyle_animEmotes") === "0";
  const key = `${emoteSizingKey()}|${still}`;
  if (last && last.emotes === emotes && last.personal === personal && last.key === key) return;
  last = { emotes, personal, key };
  const recent = getRecentEmotes(mergeForInput(emotes, personal));
  const { sections } = buildPickerData({ emotes, personal, recent, tab: "all", search: "", channelLabel: null });
  let n = 0;
  for (const sec of sections) {
    for (const [name, url] of sec.items) {
      if (n++ >= PICKER_EAGER) return;
      const src = pickerTileSrc(emotes[name] ?? personal[name] ?? { url }, still);
      if (!src || held.has(src)) continue;
      const img = new Image();
      // The tile's own CORS mode, or the tile cannot reuse this decoded copy.
      img.crossOrigin = emoteCrossOrigin(src) ?? null;
      img.decoding = "async";
      // An Image() outside the DOM starts at Chrome's LOW image priority; on a first
      // visit it would queue behind the background warm (a cold phone open can
      // take seconds otherwise).
      img.fetchPriority = "high";
      img.src = src;
      img.decode().catch(() => {});
      held.set(src, img);
    }
  }
}
