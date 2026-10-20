// The broadcaster's "highlight": the ONE message being answered on stream, shown
// to everyone with the highlight-card look (ChatMessage's `system: "highlight"`
// design). "Spotlight" in code, because two other things are already called
// highlight here — the paid highlight product and the mentions-you row tint.
//
// The pick is a `spotlight` WS frame (wsFrames.ts) — stream-api holds it in
// memory and replays it on connect — carrying the row's (platform, messageId).
// The pure pieces live here, dependency-free, so node --test pins them; the
// hook that sends a pick is useChatSpotlight.ts.

/** What rides the frame: the picked row's identity, or null for "none". */
export type SpotlightPick = { platform: string; messageId: string | number } | null;

/** The buffer's `platform:id` identity for a pick (chatSeed.ts chatKey), so a
 *  row matches by the same key whether its id arrived as a string or a number. */
export function spotlightKeyOf(pick: SpotlightPick): string | null {
  return pick ? `${pick.platform}:${pick.messageId}` : null;
}

// Where a click on a row is NOT a pick: any control inside the row (vote,
// reply, the username button, the ⋯ menu, a link), the hover toolbar's own
// padding (.row-actions — deliberately tappable surface), anything inside an
// overlay panel or card the row hosts (data-chat-panel: the settings panel,
// the user card, the sticker-boost popover), and the click that ends a
// drag-select.
const NOT_A_PICK = "button, a, input, textarea, select, [role='button'], [role='menu'], [role='menuitem'], .row-actions, [data-chat-panel]";

export function spotlightClickAllowed(target: Element | null, selectionText: string): boolean {
  if (!target) return false;
  if (selectionText.trim().length > 0) return false;
  return target.closest(NOT_A_PICK) === null;
}
