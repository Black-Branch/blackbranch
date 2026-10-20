import { platformLabel } from "./platforms.ts";
import { installValue } from "./installValues.ts";
import { siteName } from "./siteName.ts";

/**
 * Whole-message redaction armed (`send to: <site> · redacted`).
 *
 * It lives in `forcedDest` because it is genuinely exclusive with a platform —
 * a wholly redacted message is native-only — but it is NOT in the tap cycle:
 * it is armed from the tools popover or `/r`, and a tap on the button while
 * armed disarms it. A sentinel, NOT a platform: nothing in lib/platforms knows
 * it, and the send route is handed `encrypted: true` instead of a
 * `forced_destination`.
 */
export const ENCRYPTED_DEST = "encrypted";

/**
 * The support-conversation entry in the send-to cycle (`send to: <help desk>`).
 * A sentinel like 🔒, not a platform: nothing in lib/platforms knows it, it is
 * never persisted, and text sent while it is armed goes to the support panel —
 * never to /api/chat/send (which hard-rejects it as a destination).
 */
export const SUPPORT_DEST = "support";

// Composer send-destination policy. Default = the "most linked" destination the
// cycle offers: all → the single platform → native. A user who linked platforms
// wants their messages there — native-only is the no-links case.
export function defaultDest(cycle: (string | null)[]): string | null {
  // Sentinels are modes, not places — the default must never arm one. The
  // filtering lives HERE, not at call sites: the support sentinel is in every
  // main-app cycle, so a no-links user's cycle is [null, "support"] and any
  // unfiltered caller would open the help desk's panel as that user's default.
  const real = cycle.filter((d) => d !== ENCRYPTED_DEST && d !== SUPPORT_DEST);
  return real[real.length - 1] ?? null;
}
// Prune a stored destination ONLY on a successful account-links fetch that
// genuinely lacks it. A failed/empty fetch must never wipe the user's choice —
// otherwise every deploy window resets it.
//
// `encryptKnown` is the SAME hazard one layer down. The 🔒 entry only enters
// the cycle once the viewer's subscription status has loaded, and that answer
// arrives from a different request than the linked-accounts list. In the window
// where account-links has landed and /api/me has not, the cycle legitimately
// lacks 🔒 — so a Supporter's stored choice would be pruned back to native on
// every single page load. Same failure as the deploy-window reset, different
// fetch: do not prune what the cycle cannot yet contain.
export function shouldPrune(
  stored: string,
  cycle: (string | null)[],
  fetchSucceeded: boolean,
  encryptKnown = true,
): boolean {
  if (stored === ENCRYPTED_DEST && !encryptKnown) return false;
  return fetchSucceeded && !cycle.includes(stored);
}

/**
 * The composer's ONE destination signal — "where is this message going, and is
 * it going to cost me something" — as a CSS colour, or `null` when there is
 * nothing worth signalling (plain native, or "all", which is not one platform's
 * colour to claim).
 *
 * ONE chain, TWO consumers. The send button fills with it and the field
 * borders with it. They must never be computed separately — a field saying
 * Twitch beside a button saying redacted is worse than no signal at all, and
 * "message went to the wrong audience" is the exact failure the whole
 * destination-signal apparatus exists to prevent.
 *
 * The precedence is load-bearing, not aesthetic:
 *   • a bound window (a DM) outranks everything: the line goes to it and nowhere else, and a
 *     spend or reply is not applied to it (ChatInput's bound branch).
 *   • cheer outranks the rest — the send IS a coin spend, and that is the one
 *     thing here that cannot be undone.
 *   • The help desk outranks the rest, because it is the only state where the message
 *     does not reach the room AT ALL. Support does not occupy `forcedDest`, so
 *     the destination underneath is unchanged and still showing — e.g. "all" —
 *     and without this the composer would claim a fan-out for a message only
 *     the help desk will ever see.
 *   • 🔒 outranks the reply tint. Redaction wins over reply routing server-side
 *     (a redacted message never leaves the site), so painting the reply's
 *     platform colour would promise the opposite of what happens.
 *   • a reply to a routable platform outranks the sticky destination, because
 *     that is where the reply actually goes.
 */
export function composerAccent(state: {
  /** A window holds the composer (a DM): its colour, ahead of everything — the line goes there. */
  boundAccent?: string | null;
  cheerActive: boolean;
  /** Is the composer talking to the help desk rather than the room? */
  supportArmed?: boolean;
  encryptArmed: boolean;
  /** The platform of the message being replied to, if any. */
  replyPlatform?: string | null;
  forcedDest: string | null;
  /** Injected so this stays a pure function of its inputs (and testable). */
  platformColors: Record<string, string>;
  isRoutable: (platform: string) => boolean;
}): string | null {
  const { boundAccent, cheerActive, supportArmed, encryptArmed, replyPlatform, forcedDest, platformColors, isRoutable } = state;
  if (boundAccent) return boundAccent;
  if (cheerActive) return "#eab308"; // cheer armed — the send IS the coin spend
  if (supportArmed) return "var(--color-support)";
  if (encryptArmed) return "var(--color-encrypted)";
  if (replyPlatform && isRoutable(replyPlatform)) return platformColors[replyPlatform] ?? null;
  // "all" is every platform at once, so no single platform BRAND is honest for
  // it — but the site's own accent is. Null would leave the most common
  // deliberate destination looking exactly like an unstyled default.
  if (forcedDest === "all") return "var(--accent)";
  if (forcedDest) return platformColors[forcedDest] ?? null;
  return null;
}

/**
 * Where the chat box sends, as the terminal's chat TUI writes it in its typing line — the room
 * mark in the input line is what the output mode is set to. The same mapping the Send-to button
 * reads (platformLabel), lower-cased for a typing line: `#<site>`, `twitch`, `stream.place`,
 * `all`, `#<site> · redacted` — where <site> is the site's short name (else its name),
 * lower-cased.
 */
export function destMark(forcedDest: string | null): string {
  const room = `#${(installValue("site.shortName").trim() || siteName()).toLowerCase().replace(/\s+/g, "-")}`;
  if (!forcedDest) return room;
  if (forcedDest === ENCRYPTED_DEST) return `${room} · redacted`;
  if (forcedDest === "all") return "all";
  return platformLabel(forcedDest).toLowerCase();
}
