// Click a reply to jump to the message it answers; hover it to read the
// whole thing. The pure pieces live here so node --test pins them; the hook
// that drives a host is useReplyJump.ts.

import { REANCHOR_PX } from "./useAnchoredChat.ts";

/** How long the jumped-to row keeps its tint — long enough to find, short
 *  enough not to read as a selection. */
export const REPLY_FLASH_MS = 1600;

type JumpGeometry = {
  scrollTop: number; clientHeight: number; scrollHeight: number;
  /** The target row's top, in the scroller's own content coordinates. */
  rowTop: number; rowHeight: number;
};
type JumpPlan = { kind: "visible" } | { kind: "bottom" } | { kind: "scroll"; top: number };

/** Where to put the scroller so the target row is centred (or top-aligned when
 *  it is taller than the box).
 *  • "scroll": the host pauses the feed FIRST, then writes `top` — a bare
 *    scrollTop write is layout noise to useAnchoredChat, which puts an anchored
 *    feed straight back on the bottom.
 *  • "bottom": the landing spot IS the bottom (within REANCHOR_PX), so the host
 *    re-anchors instead. Writing there is undone while anchored (the engine
 *    corrects anything over 1px) and, while paused, strands the feed frozen at
 *    the bottom — the same case chatScrollKeys' PageDown already handles. */
export function replyJumpPlan(g: JumpGeometry): JumpPlan {
  const fullyVisible = g.rowTop >= g.scrollTop && g.rowTop + g.rowHeight <= g.scrollTop + g.clientHeight;
  if (fullyVisible) return { kind: "visible" };
  const centred = g.rowHeight >= g.clientHeight ? g.rowTop : g.rowTop - (g.clientHeight - g.rowHeight) / 2;
  const max = Math.max(0, g.scrollHeight - g.clientHeight);
  const top = Math.round(Math.min(max, Math.max(0, centred)));
  if (g.scrollHeight - top - g.clientHeight <= REANCHOR_PX) return { kind: "bottom" };
  return { kind: "scroll", top };
}

type ReplyFields = {
  id?: string | number | null; platform?: string | null;
  reply_to_id?: string | number | null; reply_to_username?: string | null; reply_to_text?: string | null;
};
type LoadedRow = { id?: string | number | null; platform?: string | null; username?: string | null; message?: string | null; deleted?: boolean };

/** The composer stores at most this much of the replied-to text (useSendChatMessage). */
const STORED_REPLY_CLIP = 100;

/** Shortest quote trusted to identify a message with no author match. */
const MIN_TEXT_ONLY_QUOTE = 12;

const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The loaded row a reply answers, or null when it is not loaded.
 *  • By id when the reply carries one. Ids come from two independent sequences
 *    (site messages, platform chat log), so among same-id rows the one whose
 *    author matches the quoted name wins.
 *  • A reply to a PLATFORM chatter carries NO id — the send route nulls it,
 *    because the column is a foreign key into site messages only. Those are
 *    matched the way a reader would: the nearest EARLIER row by that author
 *    whose text starts with the quoted clip — and, failing an author match, by
 *    a long enough quote alone (names differ across platforms). */
export function findReplyTarget<R extends LoadedRow>(msg: ReplyFields, loaded: readonly R[]): R | null {
  if (!msg.reply_to_username) return null;
  if (msg.reply_to_id != null) {
    const same = loaded.filter((m) => m.id != null && String(m.id) === String(msg.reply_to_id));
    return same.find((m) => sameName(m.username, msg.reply_to_username)) ?? same[0] ?? null;
  }
  const quoted = msg.reply_to_text?.trim();
  if (!quoted) return null;
  // A message sent from the site TO a platform arrives there as "@name text",
  // so a platform chatter's reply to it quotes the prefixed form — while the
  // loaded row is the site's own, without the prefix and under the author's
  // SITE name (twitch quotes `Casey: @Robin Wdym?`, the row is
  // `casey: Wdym? …`). Try the quote both ways.
  const bare = quoted.replace(/^@\S+\s+/, "");
  const startsWithQuote = (m: LoadedRow) => {
    const text = (m.message ?? "").trim();
    return text.startsWith(quoted) || (bare.length > 0 && text.startsWith(bare));
  };
  const self = loaded.findIndex((m) => m.id != null && String(m.id) === String(msg.id) && m.platform === msg.platform);
  const from = (self === -1 ? loaded.length : self) - 1;
  for (let i = from; i >= 0; i--) {
    const m = loaded[i]!;
    if (sameName(m.username, msg.reply_to_username) && startsWithQuote(m)) return m;
  }
  // The author's name differs across platforms, so fall back to the text alone
  // — only when the quote is long enough that a coincidence is implausible.
  if (bare.length < MIN_TEXT_ONLY_QUOTE) return null;
  for (let i = from; i >= 0; i--) if (startsWithQuote(loaded[i]!)) return loaded[i]!;
  return null;
}

/** What the hover preview says. The LOADED message wins, because the stored
 *  `reply_to_text` is clipped; `clipped` tells the preview to say so when all
 *  it has is a clip that filled the limit. A deleted target previews nothing. */
export function replyPreviewOf(msg: ReplyFields, loaded: readonly LoadedRow[]): { username: string; text: string; clipped: boolean } | null {
  if (!msg.reply_to_username) return null;
  const target = findReplyTarget(msg, loaded);
  if (target?.deleted) return null;
  if (target?.message) return { username: msg.reply_to_username, text: target.message, clipped: false };
  if (!msg.reply_to_text) return null;
  return { username: msg.reply_to_username, text: msg.reply_to_text, clipped: msg.reply_to_text.length >= STORED_REPLY_CLIP };
}
