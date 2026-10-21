import { postJson, networkFailureKind } from "./http";
import { siteName } from "./siteName.ts";
import { platformLabel, isRoutablePlatform } from "./platforms";
import { setCoinBalance } from "./useCoinBalance";
import { pokeCoinHeartbeat } from "./useCoinHeartbeat";
import { refreshStorePrices } from "./useStorePrices";
import { currencyName, scoreName } from "./currency";
import { REDACT_MIN_CREDIT } from "./redactedMessage";
import { featureOn } from "./siteFeatures";
import type { ChatMsg } from "./chatMsg";
import { emitChatNotice } from "./chatNotice";
import { announceHeld, HELD_PENDING_TEXT } from "./heldMessages";
import { pollVoteNotice, type DeliveryReport } from "./sendDelivery";
import { markUndelivered } from "./undeliveredLines";
import { recordFailures, skippedPlatforms } from "./platformRefusals";

/**
 * A line that IS on the site but did not reach every platform it was aimed at.
 * Never an error and never per message: the refusal
 * store decides — a persistent refusal is explained once and that platform is
 * skipped for the session; a transient failure is noted at most once per window.
 * Only a transient failure marks the line (a zero-height marker, ChatMessage).
 * An infrastructure failure (quota, 5xx, timeout) is silent unless `alone` —
 * the one platform the viewer picked — is the platform that failed.
 */
function recordUndelivered(d: DeliveryReport, alone: string | null): void {
  const failed = Array.isArray(d.failed) ? d.failed : [];
  const { marked } = recordFailures(failed, Date.now(), alone);
  if (typeof d.id === "number" && marked.length > 0) markUndelivered(d.id, marked);
}

// The /api/chat/send orchestrator: posts the message and maps every
// server-side failure mode (insufficient balance, spend relay failure, ban,
// unlinked platform, slow mode, unreachable destination) to a thrown Error
// ChatInput surfaces via setSendError. A line that went up on the site and only
// missed a platform is not one of them — see `recordUndelivered`.

// How long to wait for /api/chat/send before giving up.
//
// The send is fire-and-confirm with no optimistic row, so until this fires the
// user is looking at a cleared composer and no message. Left to the browser
// and the edge, the error arrives ~10s late on their own schedule, which is
// not a schedule we control or can reason about. Bounding it here makes the
// failure OURS: deterministic, and short enough that the composer restores the
// draft while the user still remembers sending it.
//
// Not shorter. A slow mobile network legitimately takes several seconds, and
// a timeout that fires on a request the server then completes shows a false
// failure for a message that landed.
const SEND_TIMEOUT_MS = 12_000;

// POST the send, converting a no-response rejection into wording a human can
// act on. Everything below this line already assumes a Response exists.
//
// The two branches say different things ON PURPOSE. `unreachable` means the
// request never left, so "wasn't sent" is true. `timeout` means we stopped
// waiting — the server may have processed it and only the reply was lost, so
// claiming it wasn't sent would be a guess presented as a fact. Resending is
// safe either way: a spend carries the same `spendId` until it succeeds, so the
// server replays rather than double-debiting.
async function sendOrExplain(body: Record<string, unknown>): Promise<Response> {
  try {
    return await postJson("/api/chat/send", body, "POST", { timeoutMs: SEND_TIMEOUT_MS });
  } catch (err) {
    const kind = networkFailureKind(err);
    if (kind === "unreachable") {
      throw new Error("You're offline — message not sent. It's still in the box; try again when you're back.");
    }
    if (kind === "timeout") {
      throw new Error(`${siteName()} didn't answer in time. Your message may not have sent — check chat before resending.`);
    }
    throw err;
  }
}

export function useSendChatMessage(setBanExpiry: (expiry: string | null | undefined) => void) {
  async function handleSendMessage(
    text: string,
    replyTo: ChatMsg | null,
    forcedDest?: string | null,
    spend?: { mode: "highlight" | "tts"; spendId: string; expectedPrice: number } | null,
    encrypted?: boolean
  ): Promise<string | null> {
    const skip = skippedPlatforms();
    // Send to = exactly one platform. A reply goes where the replied-to person is
    // (the route ignores the toggle), and All is several — neither is "alone".
    const alone = !replyTo && forcedDest && isRoutablePlatform(forcedDest) ? forcedDest : null;
    const res = await sendOrExplain({
      message: text,
      ...(replyTo ? {
        // A persisted card (migrate-v61) has a numeric site.chat_messages id, so
        // replies thread to it. An unpersisted (ephemeral) card has a string id
        // that is NOT a valid FK → send null or the reply row is silently dropped.
        reply_to_id: replyTo.system
          ? (typeof replyTo.id === "number" ? replyTo.id : null)
          : replyTo.id,
        reply_to_username: replyTo.username,
        reply_to_text: replyTo.message.slice(0, 100),
        reply_to_platform: replyTo.platform,
      } : {}),
      ...(forcedDest ? { forced_destination: forcedDest } : {}),
      // Platforms that refused this session for good (followers-only…) are left
      // out HERE, before the request leaves the browser — the site line still
      // posts, and no refused call is made again (platformRefusals.ts). A
      // redacted line never leaves the site, so it carries none.
      ...(skip.length > 0 && !encrypted ? { skip_platforms: skip } : {}),
      ...(spend ? { spend } : {}),
      ...(encrypted ? { encrypted: true } : {}),
    });

    // Held for a moderator (word filter / link gate): 202, so it must be caught before
    // every `res.ok` branch below — the spend one would read it as a purchase. The
    // sender sees a pending line only they can see (heldMessages.ts); a host with no
    // chat list to show it in gets the notice line instead.
    if (res.status === 202) {
      const d = (await res.clone().json().catch(() => ({}))) as { held?: boolean; rowId?: number };
      if (d.held) {
        const shown = typeof d.rowId === "number" && announceHeld({ rowId: d.rowId, text });
        if (!shown || spend) emitChatNotice(spend ? "Held for review — nothing was charged." : HELD_PENDING_TEXT);
        return null;
      }
    }
    if (spend && res.status === 402) {
      throw new Error(`Not enough ${currencyName()}.`);
    }
    // The other three refusal codes priceGuard/debitCoins can answer with
    // (chat/send route.ts). Left unhandled these would either leak a raw server
    // slug ("bad_spend") or — worse, for 409 — fall into the generic routing
    // handler further down, which is written for a platform send failing and
    // would show "Couldn't reach that platform" for what is actually a price
    // that moved. That is a wrong story, not just an ugly one.
    if (spend && res.status === 400) {
      throw new Error("That purchase wasn't understood — nothing was charged.");
    }
    if (spend && res.status === 409) {
      // The price moved between page load and this click — priceGuard's whole
      // job is refusing rather than charging a number the viewer never saw.
      // Refresh the live table (same move as useStickerSend's 409) so the
      // composer's own useItemPrice subscription already has the number the
      // server will accept before the next attempt — without this a retry
      // loops on the same stale price forever.
      const d = (await res.json().catch(() => ({}))) as { price?: number };
      refreshStorePrices();
      throw new Error(
        typeof d.price === "number"
          ? `Price just changed to ${d.price} — nothing was charged.`
          : "That price just changed — nothing was charged."
      );
    }
    if (spend && res.status === 503) {
      throw new Error("That item isn't available to buy right now — nothing was charged.");
    }
    if (spend && res.status === 502) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (d.error === "spend_failed") {
        throw new Error(`Couldn't post the message — your ${currencyName()} were refunded.`);
      }
      if (d.error === "not_spoken") {
        throw new Error(`Nothing to read aloud — a link or emotes alone don't have words. Your ${currencyName()} were refunded.`);
      }
      // unconfirmed ≠ failed: the card may have landed and was NOT refunded.
      if (d.error === "spend_unconfirmed") {
        throw new Error("Couldn't confirm it went through — if it never appeared, ask a mod for a refund.");
      }
    }
    if (spend && res.ok) {
      // The spend response carries the authoritative new balance.
      const d = await res.json().catch(() => null);
      if (d && typeof d.balance === "number") setCoinBalance(d.balance);
      // A spend is still an accepted message, and the route earns from every
      // success path — including this one.
      pokeCoinHeartbeat();
      return null;
    }
    if (res.status === 403 || res.status === 400) {
      // Redaction refusals — the 🔒 toggle, `/redact`, OR `||marks||` typed
      // into an ordinary message, so NOT gated on `encrypted`.
      // Handled BEFORE the generic 403 below, which reads any 403 as a ban.
      // Read from a clone so that branch can still read the body.
      const d = await res.clone().json().catch(() => ({}));
      if (d.error === "supporter_only") {
        // "subscribe" only where a subscription can be bought.
        throw new Error(encrypted
          ? `Redacted messages are a Supporter perk${featureOn("subscriptions") ? " — subscribe to send one" : ""}.`
          : "Redacting with || is a Supporter perk — remove the || marks to send it normally.");
      }
      // Sub-only chat (lockdown, v147) — not a ban, so it must not fall through to the ban branch.
      if (d.error === "sub_only") {
        throw new Error("Sub-only chat is on right now — only subscribers can send.");
      }
      if (d.error === "low_credit") {
        throw new Error(`You need a ${scoreName()} of at least ${REDACT_MIN_CREDIT} to send a redacted message — it goes up when people upvote your messages.`);
      }
      if (d.error === "redact_no_spend") {
        throw new Error("A highlighted or read-aloud message can't have redacted parts — nothing was charged.");
      }
      if (d.error === "encrypted_native_only") {
        throw new Error(`Redacted messages stay on ${siteName()} — they can't be sent to a platform.`);
      }
    }
    if (res.status === 403) {
      const d = await res.json().catch(() => ({}));
      if (d.error === "not_linked") {
        if (d.platform === "all") throw new Error("Link a platform account first — Settings → Linked accounts");
        const label = platformLabel(d.platform);
        throw new Error(`Link your ${label} account to reply there — Settings → Linked accounts`);
      }
      setBanExpiry(d.expiresAt ?? null);
      return null;
    }
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      if (d.error === "slow_mode") {
        // Re-arm ChatInput's local countdown from the server's number — another
        // tab may have consumed the window, or the local clock drifted.
        window.dispatchEvent(new CustomEvent("bb:slow-mode-wait", {
          detail: { retryAfterSeconds: d.retryAfterSeconds ?? 0 },
        }));
        throw new Error(`Slow mode — wait ${d.retryAfterSeconds ?? "a few"}s before sending again.`);
      }
      throw new Error(typeof d.error === "string" ? d.error : "You're sending messages too fast.");
    }
    if (res.status === 503) {
      const d = await res.clone().json().catch(() => ({}));
      if (d.error === "vote_failed") throw new Error("Your vote wasn't counted — try again.");
    }
    if (res.status === 409) {
      const d = await res.json().catch(() => ({}));
      // The site line went up BEFORE the platform answered: posted here, not there.
      // Never "message not sent" — the line is visible, and a resend would post it
      // twice — and never an error per message: it is a SENT line (the composer
      // clears, slow mode arms), and the refusal store says what needs saying.
      if (d.posted === true) {
        recordUndelivered(d, alone);
        return null;
      }
      // Explicitly chosen destination couldn't be reached — message was NOT sent.
      const label = platformLabel(d.platform ?? "that platform");
      if (d.error === "not_live") throw new Error(`${label} isn't live yet — message not sent.`);
      if (d.error === "not_featured_platform") throw new Error(`${d.featured ?? "The featured streamer"} isn't on ${label} — message not sent.`);
      if (d.error === "missing_scope") throw new Error(`Your ${label} link is missing the posting permission — re-link it in Settings → Linked accounts.`);
      throw new Error(`Couldn't reach ${label} — message not sent.`);
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error ?? "Failed to send.");
    }
    const d = await res.json().catch(() => ({}));
    // A pronoun command (`!she`, `!pronouns any` …) is answered, not posted: say
    // what it did, in the same words `/pronouns` uses (commands always answer).
    if (d && typeof d === "object" && "pronouns" in d) {
      emitChatNotice(d.pronouns ? `✓ Pronouns set to ${d.pronouns}` : "✓ Pronouns cleared");
      return null;
    }
    // A bare option number during a poll was counted as a vote and not shown.
    if (d && typeof d === "object" && d.pollVote && typeof d.pollVote.optionN === "number") {
      emitChatNotice(pollVoteNotice(d.pollVote.optionN));
      return null;
    }
    // The route awards for an accepted message FORGETFULLY, after answering —
    // so nothing in `d` can report it. Nudge the heartbeat, which is the
    // channel that can. Coalesced and delayed; see pokeCoinHeartbeat.
    pokeCoinHeartbeat();
    // Accepted, but a platform it was aimed at did not take it (a partial fan-out,
    // or a reply that only reached the site).
    if (d && typeof d === "object" && Array.isArray(d.failed) && d.failed.length > 0) recordUndelivered(d, alone);
    return (d.sentTo as string) ?? null;
  }

  return handleSendMessage;
}
