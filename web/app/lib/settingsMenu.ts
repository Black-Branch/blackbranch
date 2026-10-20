// Settings-menu layout (which settings appear, in which sections, and in what
// order). Split out of settingsRegistry.ts — this is presentation data, not
// the behavior core (parse/serialize/apply/prepaint), so it lives on its own.
// The SettingKey/Values types come from the registry as type-only imports
// (erased at compile time → no runtime cycle). The registry deliberately does
// NOT re-export this file — consumers import it directly, so the dependency
// direction stays one-way and obvious.
//
// ─── Sections ───────────────────────────────────────────────────────────────
// Rail sections — Text · Chat rows · Colours · Site & bars · Effects (then
// Behavior and Community). Colours holds every colour, the site sizes live in
// Site & bars, and Effects is the ONE home of every effect switch. No key
// appears in two sections, so one control is one place.
// (`renderControl` keys each row by the setting key, so a cross-listing would
// still be safe mechanically; it is the viewer's "where is it?" it costs.)

import { createElement, type ReactNode } from "react";
import { TextAa, Rows, Palette, Browsers, Lightning, Bell, UsersThree } from "@phosphor-icons/react/dist/ssr";
import type { SettingKey, Values } from "./settingsRegistry";

// There is no `{ type: "presets" }` item: the preset slots are not a SECTION
// of one tab — ChatSettings renders them above whichever tab is showing, so
// applying a saved look never costs a trip to a different tab and back to see
// what it did.
export type MenuItem =
  | { type: "setting"; key: SettingKey; showWhen?: (v: Values) => boolean };

// The rail's sections. Every menu section carries a `tab` and the panel
// renders only the active section's groups — except the bare `/chat` window,
// which has no tab owner and renders every section in one column.
// The icon is what a narrow panel's rail shows instead of the label
// (one-colour icons on phones). Plain data file, so no JSX here.
export type MenuTab = "text" | "rows" | "colours" | "site" | "effects" | "behavior" | "community";
const ic = (C: typeof TextAa) => createElement(C, { size: 18, weight: "bold" });
export const TABS: { key: MenuTab; label: string; icon: ReactNode }[] = [
  { key: "text",    label: "Text",        icon: ic(TextAa) },
  { key: "rows",    label: "Chat rows",   icon: ic(Rows) },
  { key: "colours", label: "Colours",     icon: ic(Palette) },
  { key: "site",    label: "Site & bars", icon: ic(Browsers) },
  { key: "effects", label: "Effects",     icon: ic(Lightning) },
  // Behavior: how the chat acts for you.
  // Not part of a look — Reset and presets skip it (registry LOOK_KEYS).
  { key: "behavior", label: "Behavior",   icon: ic(Bell) },
  // Community: the Matrix timeline's own rows. Everything it shares with the
  // live chat stays where it is.
  { key: "community", label: "Community", icon: ic(UsersThree) },
];

export interface MenuSection {
  title: string;
  items: MenuItem[];
  tab: MenuTab;
  /** ⑤ Behavior half B: an account-list editor drawn after the items
   *  (BehaviorListPanel) — the hidden people or the highlighted words. */
  panel?: "people" | "words";
  /** One line under the group title — what the group does not say by its rows alone. */
  hint?: string;
  /** Shown only when the install's plugin provides this part ("console" — the console beside
   *  the chat box, app/lib/plugins/chat.ts). The menu's renderer filters on it. */
  plugin?: "console";
}

const s = (key: SettingKey, showWhen?: (v: Values) => boolean): MenuItem => ({ type: "setting", key, showWhen });

// Relevance gates, named once and reused, so the condition and the reason live
// together instead of being re-typed as an anonymous arrow at each call site.
//
// `sendColor` is NOT gated and must never be: `sendColor` colours the vote arrows and the poll
// composer, not just the send button, so a toggle that does not actually govern them must not
// hide it.
const piIs = (mode: "bar" | "dot" | "icon") => (v: Values) => v.platformIndicator === mode;
const piShown = (v: Values) => v.platformIndicator !== "none";

export const SECTIONS: MenuSection[] = [
  // ── Text ──
  { title: "Message text", tab: "text", items: [s("fontFamily"), s("sliderVal"), s("fontWeight"), s("lineHeight"), s("msgGap")] },
  { title: "Names", tab: "text", items: [s("usernameFont"), s("usernameWeight"), s("usernameSat")] },
  { title: "Site text", tab: "text", items: [s("shellFont"), s("tabSize"), s("wordmarkSize"), s("titleSize")] },
  // The whole cluster is meaningless with timestamps off.
  { title: "Timestamps", tab: "text", items: [
    s("showTs"), s("tsFormat", (v) => v.showTs), s("tsFont", (v) => v.showTs), s("tsSize", (v) => v.showTs), s("indentTs", (v) => v.showTs),
  ] },
  // ── Chat rows ──
  { title: "Names & badges", tab: "rows", items: [s("nameStylesOn"), s("showMatrixName"), s("badgesOn"), s("badgeScale", (v) => v.badgesOn), s("badgeGap", (v) => v.badgesOn), s("pronounsOn"), s("pronounColor", (v) => v.pronounsOn)] },
  // Every tuner here is specific to ONE indicator style — showing the bar's
  // width while the dot is selected offers a control that does nothing.
  { title: "Platform", tab: "rows", items: [
    s("platformPalette"), s("platformIndicator"),
    s("piBarW", piIs("bar")), s("piBarInset", piIs("bar")), s("dotScale", piIs("dot")),
    s("piGap", (v) => piShown(v) || v.pfpOn), s("piSat", piShown),
  ] },
  { title: "Avatars", tab: "rows", items: [s("pfpOn"), s("pfpScale", (v) => v.pfpOn), s("pfpRing", (v) => v.pfpOn), s("pfpRingWidth", (v) => v.pfpOn && v.pfpRing)] },
  { title: "Layout", tab: "rows", items: [s("altRows"), s("groupConsecutive"), s("groupIndent", (v) => v.groupConsecutive), s("wrapPadding")] },
  { title: "Emotes", tab: "rows", items: [s("emoteSize"), s("emoteOverlap")] },
  // ── Colours ──
  { title: "Text colours", tab: "colours", items: [s("textColor"), s("tsColor"), s("fallbackNameMode"), s("fallbackNameColor", (v) => v.fallbackNameMode === "colour")] },
  // Model B: one page gradient behind everything (Background 1/2 +
  // Direction); every bar and the chat body are one tint over it, each with its
  // own strength (how see-through it is).
  { title: "Panel colours", tab: "colours", items: [s("bgStart"), s("bgEnd"), s("bgDir"), s("panelTint"), s("barStrength"), s("bodyStrength")] },
  { title: "Borders", tab: "colours", items: [s("frameColor"), s("frameOpacity")] },
  { title: "Shape", tab: "colours", items: [s("roundedCorners")] },
  { title: "Buttons", tab: "colours", items: [s("sendColor"), s("voteColor"), s("donateColor"), s("giftColor")] },
  // ── Site & bars ──
  { title: "Composer", tab: "site", items: [s("emoteBtnOn"), s("emoteAutoSuggest"), s("sendBtnOn"), s("sendToBtnOn"), s("toolsBtnOn")] },
  { title: "Sizes", tab: "site", items: [s("frameWidth"), s("panelGap")] },
  { title: "Tabs", tab: "site", items: [s("hideTabBar")] },
  { title: "Player", tab: "site", items: [s("streamAutoMute")] },
  // ── Effects ── (each switch lives here ONCE)
  // GLASS ≠ TRANSPARENCY: `transparencyOn` governs every translucent surface
  // (glass fill, bar tint, chat body tint); `glassOn` governs the blur ONLY,
  // which exists only on pop-ups.
  { title: "Effects", tab: "effects", items: [
    s("lowPower"), s("animEmotesOn"), s("piCycle"), s("unAnim"),
    s("seamOn"), s("seamStrength", (v) => v.seamOn), s("seamDepth", (v) => v.seamOn),
    s("chatFade"),
    // Shadow, see-through and blur last.
    s("shadowOn"), s("shadowHard", (v) => v.shadowOn), s("shadowStrength", (v) => v.shadowOn), s("shadowBlur", (v) => v.shadowOn && !v.shadowHard),
    s("shadowAngle", (v) => v.shadowOn), s("shadowDistance", (v) => v.shadowOn),
    s("transparencyOn"), s("glassColor"), s("glassOpacity"),
    s("glassOn"), s("glassBlur", (v) => v.glassOn),
  ] },
  // ── Behavior ──
  { title: "Sound", tab: "behavior", items: [s("mentionSound")] },
  { title: "Highlights", tab: "behavior", items: [s("mentionHl"), s("upvoteHl"), s("eventHl"), s("spotlightOn")] },
  { title: "Messages", tab: "behavior", items: [s("ownTint"), s("firstMark"), s("profanityFilter")] },
  // The two lists follow the ACCOUNT on every device (behaviorStore.ts), not the
  // per-device-class settings sync.
  { title: "People", tab: "behavior", items: [s("hideBots")], panel: "people" },
  { title: "Words", tab: "behavior", items: [], panel: "words" },
  { title: "Tabs", tab: "behavior", items: [s("unreadDots")] },
  { title: "History", tab: "behavior", items: [s("histLength")] },
  { title: "Windows", tab: "behavior", items: [s("winDock"), s("winFrom")] },
  // The terminal's colours and text size are its file, and the terminal is the one way into that
  // file (an immersive experience) — only the chat bar's >_ is here.
  { title: "Terminal", tab: "behavior", items: [s("termButton")], plugin: "console" },
  // ── Community ── (⑥). Text, names, badges, pronouns, avatar size, alternating
  // rows, colours and the shadow come from the chat's own rows — the hint says so.
  { title: "Timeline", tab: "community", items: [s("mxLayout"), s("mxAvatars"), s("mxTimes"), s("mxReactSize")],
    hint: "Text, names, badges, pronouns, avatar size, alternating rows, colours and the shadow follow your chat settings." },
  { title: "Edits & deletions", tab: "community", items: [s("mxEditedTag"), s("mxDeleted")] },
  { title: "Channel list", tab: "community", items: [s("mxUnread"), s("mxHideMuted")] },
  { title: "Privacy", tab: "community", items: [s("mxReceipts"), s("mxTyping")],
    hint: "Off: others don't see that you've read or are typing. Your own unread counts still clear." },
];

// ─── Menu search ─────────────────────────────────────────────────────────────
// Many sections over many groups is a hunt, and a vertical rail has a natural
// place for the field. Pure and dependency-free so it is node-testable: the
// label lookup (registry ENTRIES) and the showWhen evaluation (live values)
// both belong to the caller — ChatSettings has them, tests pass fakes.
//
// A group whose TITLE matches keeps all its visible items; otherwise only the
// items whose labels match survive. Groups left with nothing are dropped. An
// empty/whitespace query returns [] — the caller only searches when the query
// is non-empty (the tab filter is the normal path).
export function filterMenuSections(
  sections: readonly MenuSection[],
  query: string,
  labelOf: (key: SettingKey) => string,
  visible: (item: MenuItem) => boolean,
): MenuSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: MenuSection[] = [];
  for (const sec of sections) {
    const items = sec.title.toLowerCase().includes(q)
      ? sec.items.filter(visible)
      : sec.items.filter((it) => visible(it) && labelOf(it.key).toLowerCase().includes(q));
    // A list panel has no rows of its own: its group title is what search finds.
    if (items.length > 0 || (sec.panel && sec.title.toLowerCase().includes(q))) out.push({ ...sec, items });
  }
  return out;
}

// ─── Overlay / window menu ───────────────────────────────────────────────────
// The /chat window and the OBS overlay show only what changes how THEY look.
// They have no bars, no panel body (transparent canvas), no composer, no site
// chrome — so none of those settings are listed.
// Exported (not a local const inside overlaySections) so overlayMenu.test.ts
// can source-scan the exact key list as text — a real `import` here would need
// an extensionless specifier node --test cannot resolve (settingsMenu.test.ts's
// header explains why every settingsMenu guard in this repo reads source).
// @test-only overlayMenu.test.ts pins this literal Set; overlaySections (below,
// same file) is the only production consumer, so check-orphans' cross-file scan
// cannot see it.
export const OVERLAY_KEYS = new Set<SettingKey>([
  "fontFamily", "sliderVal", "fontWeight", "lineHeight", "msgGap",
  "usernameFont", "usernameWeight", "usernameSat", "showMatrixName",
  "showTs", "tsFormat", "tsFont", "tsSize", "indentTs",
  "nameStylesOn", "badgesOn", "badgeScale", "pronounsOn", "pronounColor",
  "platformPalette", "platformIndicator", "piBarW", "piBarInset", "dotScale", "piGap", "badgeGap", "piSat",
  "pfpOn", "pfpScale", "pfpRing", "pfpRingWidth",
  "altRows", "groupConsecutive", "groupIndent", "wrapPadding", "emoteSize", "emoteOverlap",
  "textColor", "tsColor", "fallbackNameMode", "fallbackNameColor", "glassColor", "glassOpacity",
  "animEmotesOn", "piCycle", "unAnim", "shadowOn", "shadowHard", "shadowStrength", "shadowBlur", "shadowAngle", "shadowDistance",
]);
// @test-only same reason as OVERLAY_KEYS just above — source-scanned, not imported.
export const WINDOW_ONLY_KEYS = new Set<SettingKey>(["chatFade", "voteColor", "histLength"]);

/** SECTIONS filtered to what the /chat window ("window") or the OBS overlay
 *  ("obs") can actually show — empty sections dropped, so a rail built from
 *  this never renders a heading with nothing under it. */
export function overlaySections(page: "window" | "obs"): MenuSection[] {
  const allow = (k: SettingKey) => OVERLAY_KEYS.has(k) || (page === "window" && WINDOW_ONLY_KEYS.has(k));
  return SECTIONS
    .map((sec) => ({ ...sec, items: sec.items.filter((it) => allow(it.key)) }))
    .filter((sec) => sec.items.length > 0);
}
