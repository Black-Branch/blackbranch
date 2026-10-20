// House looks — four site-wide saved looks (site.house_looks) that
// fill a viewer's EMPTY preset slots. A viewer's own look in a slot always wins;
// removing it brings the house look back.
/** Keys a house look never carries: the publisher's name colour would recolour
 *  the viewer's own name, and Low power (with its memory) is a device choice, not
 *  a look. Device-only settings are already absent from every saved look.
 *  (Literal keys: the registry is not loadable here; houseLooks.test.ts checks them
 *  against its `ls` names.) */
const HOUSE_STRIPPED_KEYS: readonly string[] = [
  "chatUsernameColor",
  "chatStyle_lowPower",
  "chatStyle_lowPowerPrev",
];

const STRIPPED = new Set(HOUSE_STRIPPED_KEYS);

// Low power's switches (lowPower.ts LOW_POWER_KEYS) by storage name — the blob is
// keyed by storage name. houseLooks.test.ts checks both lists against their source.
const LOW_POWER_LS: Record<string, string> = {
  animEmotesOn: "chatStyle_animEmotes", piCycle: "chatStyle_piCycle", unAnim: "chatStyle_unAnim",
  shadowOn: "chatStyle_shadow", seamOn: "chatStyle_seam", chatFade: "chatStyle_chatFade",
  transparencyOn: "theme_transparencyOn", glassOn: "theme_glassOn",
};

export function houseBlob(blob: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(blob)) if (!STRIPPED.has(k)) out[k] = v;
  // Saved while Low power was on: its switches read OFF, but the look is the one
  // Low power remembers. Put them back (what turning Low power off does), or the
  // house look would ship with glass / shadow / animation silently disabled.
  if (blob.chatStyle_lowPower === "1") {
    for (const key of (blob.chatStyle_lowPowerPrev ?? "").split(",")) {
      const ls = LOW_POWER_LS[key];
      if (ls) out[ls] = "1";
    }
  }
  return out;
}

export type Look = { name: string | null; settings: Record<string, string> };
export type SlotKind = "own" | "house" | "empty";
export type SlotView = {
  kind: SlotKind;
  name: string | null;
  settings: Record<string, string> | null;
  /** A house look sits under this slot — clearing your own brings it back. */
  houseBehind: boolean;
};

export function resolveSlot(own: Look | null, house: Look | null): SlotView {
  const houseBehind = !!house;
  if (own) return { kind: "own", name: own.name, settings: own.settings, houseBehind };
  if (house) return { kind: "house", name: house.name, settings: house.settings, houseBehind };
  return { kind: "empty", name: null, settings: null, houseBehind };
}

// Selected is a light fill with dark text: it can never collide with the accent,
// which the viewer picks and which marks their own looks.
const SELECTED = "bg-strong border border-strong text-on-accent font-medium";
const TONE: Record<SlotKind, string> = {
  own: "bg-accent/25 border border-accent/40 text-strong hover:bg-accent/35",
  house: "bg-control/50 border border-edge text-body hover:bg-control/80",
  empty: "bg-raised/60 border border-transparent text-muted cursor-default",
};

/** `selected`: the current settings ARE this slot's look. `edited`: this is the
 *  slot the viewer last picked, changed since — an outline, not the fill. */
export function slotTone(kind: SlotKind, selected: boolean, edited: boolean): string {
  if (selected && kind !== "empty") return SELECTED;
  return edited && kind !== "empty" ? `${TONE[kind]} ring-1 ring-strong` : TONE[kind];
}
