import { localpart } from "./matrixDisplay.ts";
import { stripBidiControls } from "./bidi.ts";
import type { PollState } from "./pollState";
import type { EquippedStyle } from "./usernameStyles";
import { formatMoney } from "./chatFormat.ts";
import { currencyName } from "./currency.ts";
import { NATIVE_PLATFORM } from "./nativePlatform.ts";

export type ChatMsg = {
  id: string | number;
  platform: string;
  username: string;
  message: string;
  isMod: boolean;
  isVip: boolean;
  isMember: boolean;
  // Behavior: the server's bot
  // list says this sender is a bot ("Hide bots"); isFirst = their first message
  // ever ("Mark first-time chatters" — live frames and the reconnect replay only).
  isBot?: boolean;
  isFirst?: boolean;
  // Epoch-ms on the WS wire (stream-api sends Date.now()); the history DB fetch
  // serializes it as a string. Consumers must coerce (msgTs / Number(msg.ts)).
  ts: number | string;
  // The sender's PUBLIC id on this message's platform — the id every per-person feature keys on
  // (hide, the card, "my message", reply jumps). Per person AND per platform, so a person's Twitch
  // and YouTube lines carry two ids nothing in the browser can tie together (config/public-id.mjs).
  publicId?: string | null;
  // The canonical stream id: a moderator's history page and the mod lookup (useModIds) only — the
  // public socket and a viewer's history never carry it.
  canonicalId?: string | null;
  // A SITE line's Matrix id (that account's own handle); never on a platform line.
  matrixId?: string | null;
  avatarUrl?: string | null;
  usernameColor?: string | null;
  // he/him · she/her · they/them, from stream.users on the sender's canonical
  // (stream-api frames + the history route); drawn as a symbol before the name.
  pronouns?: string | null;
  // Coin-store username style (migrate-v68) — gradient/glow, overrides the color.
  usernameStyle?: EquippedStyle | null;
  emotes?: Record<string, string> | null; // per-message platform emotes (not the global EmoteMap)
  reply_to_id?: number | null;
  reply_to_username?: string | null;
  reply_to_text?: string | null;
  score?: number | null;
  myVote?: number | null;
  // Mod-deleted: shown struck-out to mods/admins only; non-mods never receive it.
  deleted?: boolean;
  // Alternating-row stripe parity — assigned once per message by useChatMessages
  // (stable ordinal), rendered only when the chatAltRows setting is on.
  alt?: boolean;
  // Destination cue for a site message routed to a single platform (e.g. Twitch):
  // the message keeps its site identity (the site's own platform) but the color bar/icon
  // are tinted with this platform to show where it was sent. null = plain native.
  destPlatform?: string | null;
  // "Send to: all" destination set (2+ platforms) — drives the indicator
  // color cycle. Single-target sends keep using the scalar destPlatform.
  destPlatforms?: string[] | null;
  // Supporter encrypted message (migrate-v86). When true, `message` is the
  // SCRAMBLE, not the text — the plaintext never rides a WS frame or a history
  // response and is fetched per message from /api/chat/decrypt.
  encrypted?: boolean;
  // Ephemeral system event (gift / donation / sub celebration) or an
  // interactive poll. When set, the row is rendered as a distinct card instead
  // of a normal chat line. Carried fields below are only present for the
  // matching `system` kind.
  system?: "gift" | "donation" | "sub" | "alert" | "poll" | "cheer" | "highlight" | "sticker" | "tts_msg" | "sound";
  // system: "poll" — live state (tallies/status swap in place via the
  // pollUpdate/pollEnd frames; see useChatMessages + PollCard).
  poll?: PollState;
  // system: "sub" (native Stripe subscription) carries these:
  subscriberMatrixId?: string | null;
  tier?: string;
  // Seconds this contribution added to the subathon timer (all monetization cards).
  addedSeconds?: number;
  // system: "alert" (external-platform monetization event) carries these:
  alertPlatform?: string;
  eventType?: string;
  label?: string;
  recipient?: string;
  // Pre-formatted display amount (e.g. "$285.00"), DONATION alerts only —
  // stream-api's buildSystemCard withholds it for sub-family events, whose
  // `amount` is an internal revenue estimate. A STRING on purpose: `amount`
  // below is the native donation card's CENTS number, and one field carrying
  // two units is how money bugs start. Without it, platform donation cards
  // (Ko-fi, stream.place) show no dollar amount.
  amountText?: string;
  gifter?: string;
  gifterColor?: string | null;
  gifterMatrixId?: string | null;
  giftKind?: "direct" | "community";
  count?: number;
  months?: number;
  recipients?: { name: string; matrixId: string | null }[];
  donorMatrixId?: string | null;
  amount?: number; // cents
  currency?: string;
  anonymous?: boolean;
  // Coin-spend cards (migrate-v67) carry these:
  coins?: number; // spend amount (1 coin = 1¢)
  cheererMatrixId?: string | null; // system: "cheer"
  senderMatrixId?: string | null;  // sticker / tts_msg / sound
  emoteName?: string;              // system: "sticker"
  emoteUrl?: string;
  // system: "sticker" — the CUMULATIVE points boosted onto this sticker send
  // (migrate-v70). One row for the sticker's whole life — a boost updates
  // THIS SAME row in place (bumped boostCoins + created_at) rather than
  // posting a new one, so there's never a duplicate. Drives this row's render
  // size (stickerBoostScale); absent/0 on a never-boosted send.
  boostCoins?: number;
  // Transient client flag (migrate-v70): set only on the render right after a
  // boost lands, carrying the PRE-boost boostCoins. Lets the row settle at
  // its final position first, then visibly grow from the old size to the new
  // one as a distinct second step — see the boost-grow effect below.
  _prevBoostCoins?: number;
  // Transient client flag: this boost reordered the row to the bottom (it
  // wasn't already last) — triggers a FLIP-style slide to its new position
  // (see the slide effect below) instead of a fade out/in pair.
  _justMoved?: boolean;
  soundId?: string;                // system: "sound" (label reused from alerts)
  // Transient client flag: set only on live-appended messages so the entrance
  // animation plays for new arrivals but NOT for the bulk history/scrollback
  // fill (which would otherwise cascade-animate every row on load).
  _anim?: boolean;
  // Transient client flag: this viewer's last vote on THIS message was refused
  // by the per-target rate limit (429). Purely presentational and never sent —
  // it exists so the refusal is visible. Without it the optimistic score simply
  // snaps back and the click reads as "the button is broken".
  _voteCooling?: boolean;
};

export function normalizeUsername(name: string): string {
  // stripBidiControls: an unterminated U+202E in a name reverses the display of
  // whatever renders after it (the message beside it). See lib/bidi.ts.
  return stripBidiControls(localpart(name));
}

// Build a reply-target context from a monetization event so it can be replied
// to like a normal message. We force the site's own platform (a reply to an event
// is a native shout-back, never a cross-post) and synthesize a readable quote
// for the reply banner — the row's own identity fields (username/color/style/
// matrixId) already carry through unchanged.
export function cardReplyContext(m: ChatMsg): ChatMsg {
  const actor = m.system === "gift" ? (m.gifter ?? "Anonymous") : (m.username || "Anonymous");
  const count = m.count ?? m.recipients?.length ?? 1;
  const quote = m.message?.trim()
    ? m.message
    : m.system === "gift"
    ? `gifted ${count === 1 ? "1 sub" : `${count} subs`}`
    : m.system === "sub"
    ? "subscribed"
    : m.system === "donation"
    ? `donated ${formatMoney(m.amount ?? 0, m.currency ?? "usd")}`
    : m.system === "highlight"
    ? "highlighted a message"
    : m.system === "cheer"
    ? `cheered ${m.coins ?? 0} ${currencyName(m.coins ?? 0)}`
    : m.system === "sticker"
    ? `sent a sticker${m.emoteName ? ` (${m.emoteName})` : ""}`
    : m.system === "sound"
    ? `played ${m.label || "a sound"}`
    : (m.label || "supported the stream");
  return {
    ...m,
    platform: NATIVE_PLATFORM,
    username: normalizeUsername(actor),
    message: quote,
  };
}

/** The id a per-person feature keys a message's sender on: a site line's Matrix id (that account's
 *  own stable handle — what the site's ignore list and DMs already use), else the public id. Never
 *  the canonical — a viewer does not have it, and a moderator keying on it would group a person's
 *  platforms where everyone else sees them apart. */
export function personKey(m: { publicId?: string | null; matrixId?: string | null }): string | null {
  return m.matrixId ?? m.publicId ?? null;
}
