// Where a chat line actually went, and what the sender is told about it.
//
// The site line is posted FIRST (it arms the echo-suppression window), so by the
// time a platform answers, the message is already visible here. A platform
// refusing it is therefore never "message not sent": it is "posted here, not
// there", and the copy, the composer and the line itself must all say that.
//
// Pure — shared by the platform senders (server), the send route (server) and the
// send hook (client).
//
// `.ts` extensions on imports: exercised under `node --test`.
import { platformLabel, isRoutablePlatform } from "./platforms.ts";

/** One platform the line did not reach, and why. `reason` is a short phrase for
 *  the parenthesis ("followers-only"); absent when the platform gave none. */
export type DeliveryFailure = { platform: string; error: string; reason?: string };

/** What the send route answers about a line that went to the site and/or platforms. */
export type DeliveryReport = {
  /** Is the line on the site? */
  posted?: boolean;
  /** The site line's id, so the sender's own copy can be marked. */
  id?: number;
  failed?: DeliveryFailure[];
};

// The reason phrases a refusal can carry. ONE spelling each: the senders below
// write them, `deliveryFailureKind` reads them, and every client sees the same
// word because the server is the one that writes it.
export const FOLLOWERS_ONLY = "followers-only";
export const SUBSCRIBERS_ONLY = "subscribers-only";
export const BANNED_THERE = "you're banned there";
const TIMED_OUT_THERE = "you're timed out there";
const CHANNEL_SUSPENDED = "channel suspended";
const NEEDS_VERIFIED_EMAIL = "needs a verified email";
const NEEDS_VERIFIED_PHONE = "needs a verified phone";

/**
 * Refusals that will refuse the NEXT message too: the channel's mode, or the
 * sender's standing there. Explained once and skipped for the session
 * (platformRefusals.ts). Everything else — this message's content (AutoMod,
 * duplicate), a passing state (slow mode, a timeout) — is transient.
 */
const PERSISTENT_REFUSALS: ReadonlySet<string> = new Set([
  FOLLOWERS_ONLY, SUBSCRIBERS_ONLY, BANNED_THERE, CHANNEL_SUSPENDED, NEEDS_VERIFIED_EMAIL, NEEDS_VERIFIED_PHONE,
]);

// Twitch's documented drop codes (Helix "Send Chat Message" → drop_reason.code),
// and the phrase each one becomes. Unknown codes fall back to the platform's own
// message, which Twitch writes for people to read.
const TWITCH_DROP: Record<string, string> = {
  msg_duplicate: "duplicate message",
  msg_r9k: "unique-chat mode",
  msg_followersonly: FOLLOWERS_ONLY,
  msg_followersonly_followed: FOLLOWERS_ONLY,
  msg_followersonly_zero: FOLLOWERS_ONLY,
  msg_subsonly: SUBSCRIBERS_ONLY,
  msg_emoteonly: "emote-only",
  msg_slowmode: "slow mode",
  msg_banned: BANNED_THERE,
  msg_timedout: TIMED_OUT_THERE,
  msg_verified_email: NEEDS_VERIFIED_EMAIL,
  msg_requires_verified_phone_number: NEEDS_VERIFIED_PHONE,
  msg_channel_suspended: CHANNEL_SUSPENDED,
  msg_rejected: "held by AutoMod",
  msg_rejected_mandatory: "blocked term",
  automod_held: "held by AutoMod",
};

// Kick gives no code, only a sentence. Recognised by what the sentence is about.
const KICK_PATTERNS: [RegExp, string][] = [
  [/follow/i, FOLLOWERS_ONLY],
  [/subscri/i, SUBSCRIBERS_ONLY],
  [/emote/i, "emote-only"],
  [/slow/i, "slow mode"],
  [/duplicate|same message/i, "duplicate message"],
  [/timed? ?out/i, TIMED_OUT_THERE],
  [/bann/i, BANNED_THERE],
];

const MAX_REASON = 80;

/** A platform's own sentence, made safe to show: one line, bounded, no markup. */
function tidy(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX_REASON ? `${t.slice(0, MAX_REASON - 1)}…` : t;
}

type SendOutcome = { sent: true; id?: string } | { sent: false; reason?: string };

/** Helix answers 200 with `is_sent: false` for a message it dropped (AutoMod,
 *  followers-only, duplicate…). That is a refusal, not a success. */
export function twitchSendOutcome(body: unknown): SendOutcome {
  const row = (body as { data?: { message_id?: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } | null }[] } | null)?.data?.[0];
  if (row?.is_sent === false) {
    const code = row.drop_reason?.code;
    return { sent: false, reason: (code && TWITCH_DROP[code]) || tidy(row.drop_reason?.message) };
  }
  return { sent: true, ...(row?.message_id ? { id: row.message_id } : {}) };
}

/** A Kick sentence → a known phrase, else the sentence itself. */
function kickReason(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  for (const [re, phrase] of KICK_PATTERNS) if (re.test(message)) return phrase;
  return tidy(message);
}

/** Kick's 2xx answer: `{ data: { is_sent, message_id } }`; `is_sent: false` is a refusal. */
export function kickSendOutcome(body: unknown): SendOutcome {
  const b = body as { message?: string; data?: { message_id?: string | number; is_sent?: boolean } } | null;
  if (b?.data?.is_sent === false) return { sent: false, reason: kickReason(b.message) };
  const id = b?.data?.message_id;
  return { sent: true, ...(id != null && id !== "" ? { id: String(id) } : {}) };
}

/** A Kick answer whose sentence names a KNOWN refusal ("slow mode", "followers"…), or null.
 *  Checked before the status is judged: a 429 carrying "slow mode" is the channel's mode, not
 *  Kick failing. */
export function kickKnownRefusal(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  for (const [re, phrase] of KICK_PATTERNS) if (re.test(message)) return phrase;
  return null;
}

/**
 * Kick's bare 403 ("Forbidden", no sentence to read) on a chat send, classified per CHANNEL
 * (contract 10): Kick says the same word for a followers-only chat, a ban and a missing grant. A
 * channel whose chat Kick reports as followers-only (`followersOnly` true) → a followers-only
 * refusal: viewer-actionable, one note per session. Anything else — not followers-only, or the
 * mode could not be read — is not assumed: silent like infrastructure, and the
 * route logs its shape.
 */
export function kickForbiddenOutcome(followersOnly: boolean | null): { refused: true; reason: string } | Unavailable {
  if (followersOnly === true) return { refused: true, reason: FOLLOWERS_ONLY };
  return { error: UNAVAILABLE, reason: "upstream", code: "kick.http_403" };
}

/** A JSON body's SHAPE for a log line — keys and value types, two levels deep, never a value:
 *  `{data:{},message:string}`. What a platform says can name people; its shape cannot. */
export function bodyShape(body: unknown, depth = 0): string {
  if (body === null) return "null";
  if (Array.isArray(body)) return depth >= 2 ? "[…]" : `[${body.length ? bodyShape(body[0], depth + 1) : ""}]`;
  if (typeof body !== "object") return typeof body;
  if (depth >= 2) return "{…}";
  return `{${Object.keys(body as Record<string, unknown>).slice(0, 12).map((k) => `${k}:${bodyShape((body as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
}

/** Kick's non-2xx answer. A 4xx carrying a sentence is the channel refusing the
 *  message (followers-only, banned…); anything else is a failure to reach it. */
export function kickErrorOutcome(status: number, body: unknown): { refused: true; reason?: string } | { refused: false } {
  if (status < 400 || status >= 500 || status === 401 || status === 404) return { refused: false };
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || !message.trim()) return { refused: false };
  return { refused: true, reason: kickReason(message) };
}

// ── Infrastructure: failures the viewer cannot act on ───────────────────────
// The platform's API quota, a rate limit, an upstream 5xx, a timeout, our own
// token/DB throw. The route reports them as error `unavailable` with one of these
// causes as `reason`; `code` names the provider's own reason for the journal
// (`youtube.quota`) and never leaves the server (`failureOf` drops it).

/** Why a platform could not be reached. A stable word, never the provider's text. */
export type InfraCause = "quota" | "rate_limited" | "upstream" | "timeout" | "internal";
export type Unavailable = { error: "unavailable"; reason: InfraCause; code: string };

const UNAVAILABLE = "unavailable";
const YT_QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const YT_RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** A Twitch/Kick/YouTube HTTP status that says the platform, not the viewer, failed: 429 or 5xx. */
export function httpUnavailable(platform: string, status: number): Unavailable | null {
  if (status === 429) return { error: UNAVAILABLE, reason: "rate_limited", code: `${platform}.http_${status}` };
  if (status >= 500) return { error: UNAVAILABLE, reason: "upstream", code: `${platform}.http_${status}` };
  return null;
}

/** YouTube's non-2xx answer (`{ error: { errors: [{ domain, reason }] } }`) to a Data API call. */
export function youtubeErrorOutcome(status: number, body: string): Unavailable | { error: "missing_scope" | "send_failed" } {
  let errs: { domain?: unknown; reason?: unknown }[] = [];
  try {
    const list = (JSON.parse(body) as { error?: { errors?: unknown } } | null)?.error?.errors;
    if (Array.isArray(list)) errs = list.filter((e): e is { domain?: unknown; reason?: unknown } => !!e && typeof e === "object");
  } catch { /* not JSON — judged by the status alone */ }
  if (errs.some((e) => e.domain === "youtube.quota" || YT_QUOTA_REASONS.has(String(e.reason)))) {
    return { error: UNAVAILABLE, reason: "quota", code: "youtube.quota" };
  }
  const rate = errs.find((e) => YT_RATE_REASONS.has(String(e.reason)));
  if (rate) return { error: UNAVAILABLE, reason: "rate_limited", code: `youtube.${String(rate.reason)}` };
  // The viewer unchecked "Manage your YouTube account" on Google's consent screen: re-linking fixes it.
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(body)) return { error: "missing_scope" };
  return httpUnavailable("youtube", status) ?? { error: "send_failed" };
}

// A TypeError that is NOT fetch's own network failure is a bug in our code (an undefined read):
// silent to viewers like every infrastructure failure, but its stack is logged — at most once per
// STACK_LOG_MS per message — so it can be found. Server-side only in practice: the senders
// call this.
const STACK_LOG_MS = 10 * 60_000;
const stackLogged = new Map<string, number>();

/** A platform send that threw instead of answering: our own 8 s abort, the network, or our token/DB code. */
export function thrownFailure(err: unknown, now: number = Date.now(), log: Pick<Console, "error"> = console): Unavailable {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return { error: UNAVAILABLE, reason: "timeout", code: "timeout" };
  // fetch (undici) rejects a failed connection as TypeError("fetch failed") with the cause attached.
  if (err instanceof TypeError && (err.message === "fetch failed" || err.cause !== undefined)) {
    return { error: UNAVAILABLE, reason: "upstream", code: "network" };
  }
  if (err instanceof TypeError) {
    const key = err.message.slice(0, 200);
    const last = stackLogged.get(key);
    if (last === undefined || now - last >= STACK_LOG_MS) {
      stackLogged.set(key, now);
      log.error(`[sendDelivery] a platform send threw a TypeError (our code, not the network) — the viewer was not told:\n${err.stack ?? err.message}`);
    }
    return { error: UNAVAILABLE, reason: "internal", code: "type_error" };
  }
  return { error: UNAVAILABLE, reason: "internal", code: "exception" };
}

/** A platform sender's failure as the route reports it — never its provider `code`. */
export function failureOf(platform: string, r: { error: string; reason?: string }): DeliveryFailure {
  return { platform, error: r.error, ...(r.reason ? { reason: r.reason } : {}) };
}

/**
 * Which of three classes a failure is. THE one place the split is made; the
 * send hook acts on it (platformRefusals.ts).
 *
 *   class          | what                                                     | the viewer sees
 *   ---------------|----------------------------------------------------------|-------------------------------
 *   persistent     | refused: followers-only, subscribers-only, banned there, | one note per session; the
 *                  | channel suspended, needs a verified email / phone        | platform skipped until re-picked
 *   transient      | refused: duplicate, unique-chat, emote-only, slow mode,  | a note at most once per platform
 *                  | timed out there (a moderator's timeout), AutoMod,        | per window; the ⊘ on the line
 *                  | blocked term, an unknown sentence; not_live,             |
 *                  | missing_scope, not_linked, crosspost_locked,             |
 *                  | command_native_only, send_failed (an unclassified 4xx)   |
 *   infrastructure | unavailable: quota, rate_limited, upstream (5xx,         | nothing when the line went to
 *                  | network), timeout (our abort), internal (our token/DB    | All; ONE "Couldn't reach X chat
 *                  | throw, the channel not configured)                       | right now." per platform per
 *                  |                                                          | session when X alone was picked
 *
 * Viewer-facing notices only for what the viewer can act on or should know is
 * passing; infrastructure is logged for the operator instead
 * (copyFailureLog.ts).
 */
export function deliveryFailureKind(f: DeliveryFailure): "persistent" | "transient" | "infrastructure" {
  if (f.error === UNAVAILABLE) return "infrastructure";
  return f.error === "refused" && f.reason != null && PERSISTENT_REFUSALS.has(f.reason) ? "persistent" : "transient";
}

/** More than every routable platform there is; a longer list is not a real client. */
const MAX_SKIP = 16;

/**
 * The send body's `skip_platforms`: platforms the sender's own client has
 * stopped posting to for this session (a persistent refusal). Only a routable
 * platform id survives, and the route only ever REMOVES these from the sender's
 * own targets — a skip list can never add a destination.
 */
export function skipPlatformsFrom(body: unknown): Set<string> {
  const raw = (body as { skip_platforms?: unknown } | null)?.skip_platforms;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const p of raw.slice(0, MAX_SKIP)) if (typeof p === "string" && isRoutablePlatform(p)) out.add(p);
  return out;
}

/** What stream-api's /chat/native answered, as far as the sender is concerned:
 *  the site line's id, or the poll vote the line was counted as instead. */
export function nativeAnswer(json: unknown): { id?: number; pollVote?: { optionN: number } } {
  const j = json as { id?: unknown; pollVote?: { optionN?: unknown } } | null;
  const id = Number(j?.id);
  const n = Number(j?.pollVote?.optionN);
  return {
    ...(j?.id != null && Number.isInteger(id) ? { id } : {}),
    ...(j?.pollVote && Number.isInteger(n) ? { pollVote: { optionN: n } } : {}),
  };
}

/** One platform's failure as a clause: "Kick refused it (followers-only)". */
function failureClause(f: DeliveryFailure): string {
  // "all" is the fan-out destination, not a platform with a name of its own.
  const label = f.platform === "all" ? "your linked platforms" : platformLabel(f.platform);
  switch (f.error) {
    case "refused": return `${label} refused it${f.reason ? ` (${f.reason})` : ""}`;
    case "not_live": return `${label} isn't live`;
    case "not_linked": return `your ${label} account isn't linked`;
    case "missing_scope": return `your ${label} link needs re-linking (Settings → Linked accounts)`;
    case "crosspost_locked": return `posting to ${label} is paused right now`;
    case "command_native_only": return `commands aren't sent to ${label}`;
    case UNAVAILABLE: return `couldn't reach ${label}`;
    default: return `couldn't reach ${label}${f.reason ? ` (${f.reason})` : ""}`;
  }
}

/** The sentence for a line that reached the site but not everywhere it was aimed:
 *  "Posted here — Kick refused it (followers-only)". `null` when nothing failed. */
export function describeDelivery(report: DeliveryReport): string | null {
  const failed = report.failed ?? [];
  if (failed.length === 0) return null;
  const clauses = failed.map(failureClause).join("; ");
  return report.posted ? `Posted here — ${clauses}.` : `Not sent — ${clauses}.`;
}

/** The composer's note for a line stream-api counted as a poll vote instead of showing it. */
export function pollVoteNotice(optionN: number): string {
  return `Counted as a vote for option ${optionN}`;
}

/** The sender's own line's marker label (aria/title): "not delivered to Kick". */
export function undeliveredLabel(platforms: readonly string[]): string {
  if (platforms.includes("all")) return "not delivered to other platforms";
  return `not delivered to ${platforms.map((p) => platformLabel(p)).join(", ")}`;
}
