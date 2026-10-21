import pool from "@/lib/db";
import { messageVisibleSql } from "@/app/lib/instanceSchema.generated.mjs";
import { askPronounCommand, PRONOUN_USAGE } from "@/app/lib/pronounCommand";
import { requireUser } from "@/app/lib/authGuard";
import { streamApiFetch } from "@/app/lib/streamApi";
import { deliverChatEvent } from "@/app/lib/chatEventDelivery";
import { sendToPlatform, platformOutgoingText, isRoutablePlatform, stripLongEmoteNames, type SendTarget, type PlatformSendResult } from "@/app/lib/platformChat";
import { canCrossPost } from "@/app/lib/platforms";
import { getStreamStatus } from "@/app/lib/streamStatus";
import { sanitizeChatMessage } from "@/app/lib/sanitize";
import { classify } from "@/app/lib/blacklist";
import { gate, currentPosture } from "@/app/lib/linkGate";
import { recordBlocklistHit, holdBlocklistHit, recordLinkHit, holdLinkHit } from "@/app/lib/blocklistReview";
import { askAutomod, automodEnabled, automodExempt, skipSupporters } from "@/app/lib/automodHold";
import { isCrosspostLocked, isSubOnly } from "@/app/lib/lockdown";
import { isPlatformCommand } from "@/app/lib/outgoingText";
import { getActiveTier, chatRateLimitFor } from "@/app/lib/entitlements";
import { staffMatrixIds } from "@/app/lib/staff";
import { debitCoins, refundCoins, earn } from "@/app/lib/coinsServer";
import { recordPlatformCopies, registerEchoCopy } from "@/app/lib/platformCopies";
import { storePricing } from "@/app/lib/storePricingServer";
import { priceGuard } from "@/app/lib/storePricing";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { parseRedaction, REDACT_MIN_CREDIT } from "@/app/lib/redactedMessage";
import { SUPPORT_DEST } from "@/app/lib/sendDestination";
import { resolveIdentities, getSocialCredit } from "@/lib/socialCredit";
import { getPersonalEmotes } from "@/app/lib/userEmotesServer";
import { resolveOutgoingEmotes } from "@/app/lib/personalEmotes";
import { getManifest } from "@/app/api/emotes/route";
import { chatCharLimit } from "@/app/lib/chatLimits";
import { NextRequest } from "next/server";
import { NATIVE_PLATFORM, isNativePlatform, normalizePlatform } from "@/app/lib/nativePlatform";
import { failureOf, nativeAnswer, skipPlatformsFrom, thrownFailure } from "@/app/lib/sendDelivery";
import { logCopyFailure } from "@/app/lib/copyFailureLog";

// N messages per 5 seconds per user. N depends on the user's subscription tier
// (subscribers get a higher ceiling), passed per call below; the factory
// default is the base (no-sub) ceiling.
const isRateLimited = createSlidingWindowLimiter(5_000, chatRateLimitFor(null));

// Redacted messages have NO cooldown. A cooldown would disarm the redaction
// toggle after each send, and a disarmed toggle is how a sender posts their
// next message in the clear without meaning to. Supporter + social credit ≥ 1
// remain the gates.

// Slow-mode enforcement state: the singleton setting cached briefly (one DB read
// per ~5s across all senders, and a mid-stream change propagates fast), plus each
// non-mod's last accepted send. Mods/admins are exempt.
let slowModeCache: { seconds: number; ts: number } | null = null;
const SLOW_CACHE_MS = 5_000;
const lastSlowSend = new Map<string, number>();

async function currentSlowMode(): Promise<number> {
  if (slowModeCache && Date.now() - slowModeCache.ts < SLOW_CACHE_MS) return slowModeCache.seconds;
  const { rows } = await pool
    .query<{ slow_mode_seconds: number }>(`SELECT slow_mode_seconds FROM site.chat_settings WHERE id = 1`)
    .catch(() => ({ rows: [] as { slow_mode_seconds: number }[] }));
  const seconds = rows[0]?.slow_mode_seconds ?? 0;
  slowModeCache = { seconds, ts: Date.now() };
  return seconds;
}

// Per-user slow mode.
//
// Cached as the WHOLE active set in one query, not looked up per sender. This
// sits on the accepted-message path, so a per-sender SELECT would add a round
// trip to every chat send in the room; the set is tiny (mods limit a handful of
// people at most) and the same 5s window as the global setting keeps a mid-stream
// change propagating fast. Expired rows are filtered in SQL — they are kept on
// the table so `/slowmode list` and the mod log can still show what was done.
let userSlowCache: { map: Map<string, number>; ts: number } | null = null;

async function currentUserSlowModes(): Promise<Map<string, number>> {
  if (userSlowCache && Date.now() - userSlowCache.ts < SLOW_CACHE_MS) return userSlowCache.map;
  const { rows } = await pool
    .query<{ matrix_id: string; seconds: number }>(
      `SELECT matrix_id, seconds FROM site.user_slow_mode
        WHERE expires_at IS NULL OR expires_at > NOW()`
    )
    .catch(() => ({ rows: [] as { matrix_id: string; seconds: number }[] }));
  const map = new Map(rows.map((r) => [r.matrix_id, r.seconds]));
  userSlowCache = { map, ts: Date.now() };
  return map;
}

// +1 coin for an accepted message while the stream is live (capped in
// coinsServer). Fire-and-forget from every SUCCESS return — must never delay
// or fail the send it rewards.
function maybeEarnChatCoin(matrixId: string): void {
  // The live check stays here as well as inside earnMessage. earnMessage
  // resolves the CURRENT STREAM and no-ops without one, which is the real gate;
  // this one just avoids a pointless round trip for the off-stream case.
  void getStreamStatus()
    .then((s) => (s.live ? earn.earnMessage(matrixId) : undefined))
    // Loud, not swallowed: a silent catch here makes an earning outage
    // indistinguishable from a quiet stream — for as long as nobody thinks to
    // look.
    .catch((e) => console.error("[points-earn] chat-message earn failed:", e));
}

/** A held message's answer: 202 + the review row's id, which the sender's pending line
 *  polls by. A hold whose row was never written holds nothing, so it is a failure. */
function heldResponse(rowId: number | null, error: string): Response {
  if (rowId == null) {
    return Response.json({ error: "Couldn't hold your message for review — try again." }, { status: 500 });
  }
  return Response.json({ error, held: true, rowId }, { status: 202 });
}

export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  // ── Concurrent identity reads ───────────────────────────────────────────
  // Four independent reads — tier, ban row, style/privilege row, canonical
  // link — awaited serially would be four cross-machine round-trips of dead time
  // on the most common user action. None depends on another's RESULT; only
  // the checks have an order (rate limit, then ban), and checking in order
  // does not require fetching in order. Kicked off together here, each one
  // awaited at its existing checkpoint below.
  const reads = {
    tier: getActiveTier(matrixId),
    bans: pool.query(
      `SELECT expires_at FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [matrixId]
    ),
    user: pool.query(
      `SELECT username_color, username_style, display_name, is_mod, is_admin FROM site.users WHERE matrix_id = $1`,
      [matrixId]
    ).catch(() => ({ rows: [] as { username_color: string | null; username_style: object | null; display_name: string | null; is_mod: boolean; is_admin: boolean }[] })),
    link: pool.query(
      `SELECT canonical_id FROM site.platform_links WHERE matrix_id = $1 LIMIT 1`,
      [matrixId]
    ).catch(() => ({ rows: [] as { canonical_id: string | null }[] })),
  };
  // reads.bans deliberately has no inline .catch — a failed ban check must
  // fail the send (fail closed), never default to "not banned". But several
  // returns below exit before its checkpoint, and an unobserved rejection
  // takes the process down; this detached handler marks it observed without
  // changing what `await reads.bans` throws.
  reads.bans.catch(() => {});

  const tier = await reads.tier;
  if (isRateLimited(matrixId, chatRateLimitFor(tier))) {
    return Response.json({ error: "Slow down — you're sending messages too fast." }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });
  const { reply_to_id } = body;
  const reply_to_username = typeof body.reply_to_username === "string" ? body.reply_to_username.slice(0, 50) : null;
  const reply_to_text = typeof body.reply_to_text === "string" ? body.reply_to_text.slice(0, 100) : null;
  // A page opened before the platform-key rename may still send the site's old id (nativePlatform.ts).
  const reply_to_platform = typeof body.reply_to_platform === "string" ? String(normalizePlatform(body.reply_to_platform)) : null;
  const fd = typeof body.forced_destination === "string" ? body.forced_destination : null;
  // Support-mode text is a PRIVATE conversation with the help desk. The
  // coercion below maps any unroutable destination to null — and null means
  // native — so a support send reaching this route would post the user's
  // support question to PUBLIC chat. Refuse loudly instead.
  if (fd === SUPPORT_DEST) return new Response("support is not a chat destination", { status: 400 });
  // "all" is a fan-out pseudo-destination handled below; the rest must be routable.
  const forced_destination = fd && (isRoutablePlatform(fd) || fd === "all") ? fd : null;
  // Platforms the sender's own client stopped posting to this session — a
  // persistent refusal (followers-only, banned there…; platformRefusals.ts). They
  // only ever come OUT of the sender's own targets below, on all three outbound
  // paths, and the site line still posts; a skip list can never add a destination.
  const skipPlatforms = skipPlatformsFrom(body);

  // ── Character limit (chatLimits.ts) ──────────────────────────────────────
  // `userRow` is awaited HERE, ahead of its other uses further down, so role
  // and TTS-mode are both known BEFORE the message is sanitized — sanitizing
  // first at a flat 500 would be wrong: staff's own limit is also 500, so a
  // mod's over-length message would be cut to exactly 500 and the
  // `> charLimit` check below could never see it as over. Sanitizing at
  // `charLimit + 1` instead means every tier's overflow still measures one
  // character past its own ceiling.
  //
  // `isPrivileged` folds in staffMatrixIds(), not just `is_mod`/`is_admin` —
  // the streamer or the bot could otherwise be held to the 200-char viewer limit if
  // their row's flags are unset.
  const userRow = await reads.user;
  const isPrivileged =
    !!(userRow.rows[0]?.is_mod || userRow.rows[0]?.is_admin) || staffMatrixIds().has(matrixId);
  const ttsMode = body?.spend?.mode === "tts";
  const charLimit = chatCharLimit(
    { isMod: isPrivileged, isAdmin: !!userRow.rows[0]?.is_admin },
    ttsMode ? "tts" : null
  );
  // SANITIZED AT A WIDE CAP, AND A MESSAGE THAT HITS IT IS REFUSED, NEVER
  // TRUNCATED. `||hidden||` marks do not count toward the limit, so the raw text
  // may legitimately run past charLimit; and a truncation that cut off a CLOSING
  // mark would leave the opening one unpaired — literal — and post the hidden
  // words in the clear. Any cut at all is therefore a 413 (at the length check
  // below, so the ban/blocklist ordering there is unchanged).
  const rawCap = charLimit * 2 + 1;
  const rawMessage = sanitizeChatMessage(typeof body.message === "string" ? body.message : "", rawCap);
  if (!rawMessage) return new Response("Bad Request", { status: 400 });
  const rawTruncated = rawMessage.length >= rawCap;

  // ── Redaction (whole or partial) ──────────────────────────────────────────
  // `message` is the PLAINTEXT from here on — marks removed — and it is what
  // the word filter, the link gate and the length limit judge, so hiding a word
  // is never a way past any of them. What is actually posted is chosen at each
  // send below: `red.publicText` (hidden parts as placeholder glyphs) to
  // the site, `red.platformText` (hidden parts as "[REDACTED]") to platforms.
  // The plaintext itself goes ONLY into `encryptedText`, which stream-api
  // stores in site.chat_messages.encrypted_text and never broadcasts.
  const wholeRedact = body.encrypted === true;
  const red = parseRedaction(rawMessage, wholeRedact);
  const message = red.plain;
  const redactExtra = red.redacted ? { encryptedText: message } : {};

  // ── Ban check (ahead of the blocklist and the length check) ─────────────────
  // A banned sender must get 403, not whatever the classifier or the length
  // check would have said about the same text — checking it first means
  // neither of those runs for someone who cannot send anyway.
  const { rows } = await reads.bans;
  if (rows.length > 0) {
    return Response.json({ error: "banned", expiresAt: rows[0].expires_at }, { status: 403 });
  }

  // ── Sub-only chat (lockdown, v147) ─────────────────────────────────────────
  // After the ban check, before anything else looks at the text: only a subscriber, a mod or an
  // admin may send while it holds. Site chat only — platform chat is the platform's own. Fails
  // open (lockdown.ts isSubOnly): it withholds conversation.
  if (await isSubOnly()) {
    const u = (await reads.user).rows[0];
    if (!tier && !u?.is_mod && !u?.is_admin) {
      return Response.json({ error: "sub_only" }, { status: 403 });
    }
  }

  // ── Word blocklist: severity decides the outcome (v84) ────────────────────
  // A flat reject with no record would teach a mod nothing about who keeps
  // trying. `classify` is pure and in-memory (µs); the review row is written
  // fire-and-forget, and only for a message that is not being delivered anyway —
  // so a clean send pays nothing new.
  const verdict = classify(message);
  if (verdict.action !== "allow") {
    // Severity 4 is refused outright; 2-3 are genuinely withheld pending a mod.
    // Different words on purpose: "blocked" is final, "held for review" is not,
    // and a sender who is told the wrong one will either retry pointlessly or
    // assume they were censored.
    if (verdict.action === "block") {
      recordBlocklistHit({ verdict, text: message, matrixId, platform: NATIVE_PLATFORM });
      return Response.json({ error: "Your message was blocked by the word filter." }, { status: 422 });
    }
    // A hold waits for its row: the sender's pending line follows the message by
    // that id (GET /api/chat/held/[id]). No row = nothing is holding it.
    const rowId = await holdBlocklistHit({ verdict, text: message, matrixId });
    return heldResponse(rowId, "Held for review — a moderator will take a look shortly.");
  }

  // Reject, never truncate: the box already stops typing at this number, so
  // a longer message here is a stale draft or a hand-made request. Name the
  // number so the sender knows what to cut. Checked AFTER the ban and the
  // blocklist so a banned sender still gets 403 and a blocklisted over-long
  // message is still recorded — neither outcome is silently replaced by a
  // plain length error — and still well before anything that persists or
  // sends the message.
  if (rawTruncated || message.length > charLimit) {
    return Response.json({ error: `Messages are limited to ${charLimit} characters.` }, { status: 413 });
  }

  // ── Link gate ─────────────────────────────────────────────────────────────
  //
  // A link from a host nobody has allowlisted is treated exactly like a
  // mid-severity word: HELD for a mod, never destroyed. It reuses the same
  // review queue.
  //
  // DORMANT UNLESS ARMED. `gate()` returns allow immediately at posture
  // `off`, which is the default — it does not even scan for URLs. `flag`
  // records the hit and DELIVERS the message, so the blast radius can be
  // measured on a real stream before anyone turns it on.
  const linkVerdict = gate(message);
  if (linkVerdict.action === "hold") {
    const flagOnly = currentPosture() === "flag";
    // recordLinkHit, NOT recordBlocklistHit. `source = 'link_gate'` is what
    // makes the row releasable — the resolve route's RELEASABLE list dispatches
    // on it. Recorded as 'blocklist', Allow would mark the row resolved and the
    // message would never appear ("held" would be a lie), and the reason and
    // the flag-only marker would be lost.
    if (!flagOnly) {
      const rowId = await holdLinkHit({ host: linkVerdict.host, reason: linkVerdict.reason, text: message, matrixId });
      return heldResponse(rowId, `Held for review — links to ${linkVerdict.host} need a moderator's OK.`);
    }
    recordLinkHit({
      host: linkVerdict.host,
      reason: linkVerdict.reason,
      text: message,
      matrixId,
      flagOnly,
    });
    // flag mode: fall through and deliver.
  }

  // ── Redaction gates ────────────────────────────────────────────────────────
  // For the lock toggle, `/redact`, AND `||marks||` in an ordinary message. A
  // non-Supporter's marked message is REFUSED, not sent with the marks shown:
  // posting it would publish exactly the words they asked to hide.
  if (red.redacted) {
    if (!tier) {
      return Response.json({ error: "supporter_only" }, { status: 403 });
    }
    // Social credit ≥ 1. The right currency BECAUSE IT CANNOT BE BOUGHT — points
    // can, and a purchasable anti-abuse gate is one a bad actor buys through.
    // A threshold only; nothing is spent.
    // reads.link is awaited here as well as further down; a settled promise
    // is free to await again.
    const ids = await resolveIdentities({ matrixId, canonicalId: (await reads.link).rows[0]?.canonical_id ?? null });
    const credit = await getSocialCredit(ids);
    if (credit < REDACT_MIN_CREDIT) {
      return Response.json({ error: "low_credit", credit, need: REDACT_MIN_CREDIT }, { status: 403 });
    }
    // A bought highlight is a public card and a read-aloud is SPOKEN on stream
    // — both would publish the hidden words. Refused before any debit.
    if (body.spend) {
      return Response.json({ error: "redact_no_spend" }, { status: 403 });
    }
  }

  // Pronoun commands (`!she`, `!she/her`, `!pronouns she`, `!pronouns any` …) set the
  // pronouns on the canonical identity and are not posted as chat. stream-api's
  // /identity/pronoun-command is the ONE parser — platform chat asks it too — so
  // every `!` line is offered to it; anything it does not claim posts as normal.
  // One it cannot read answers with the usage line rather than posting silently.
  if (message.trimStart().startsWith("!")) {
    const r = await askPronounCommand({ text: message, matrixId });
    if (r?.matched) {
      if (r.usage) return Response.json({ error: PRONOUN_USAGE }, { status: 422 });
      return Response.json({ ok: true, pronouns: r.pronouns ?? null });
    }
  }

  // ── Automod: HOLDS a risky message for a moderator ───────────────────────────
  // Here — after the word filter, the length check, the link gate, the redaction gates and the
  // commands this route handles (they return above), before any spend or debit — so a held paid
  // message is never charged, and no text the sender types can skip it. Exemptions are
  // server-side facts only (automodHold.ts). A partly hidden message sends its PUBLIC text
  // (hidden parts as placeholders): the hidden words are not sent to a provider; the word filter
  // and link gate above did judge them.
  if (automodEnabled() && !automodExempt({
    isPrivileged, wholeRedacted: wholeRedact,
    isSupporter: !!tier, skipSupporters: skipSupporters(),
  })) {
    const verdict = await askAutomod({ matrixId, username: userRow.rows[0]?.display_name ?? null, text: red.redacted ? red.publicText : message });
    if (!verdict.held && verdict.refused) {
      return Response.json({ error: "You have messages waiting for a moderator — wait until they are reviewed." }, { status: 429 });
    }
    if (verdict.held) {
      return heldResponse(verdict.rowId, body.spend
        ? "Held for review — nothing was charged. A moderator will take a look shortly."
        : "Held for review — a moderator will take a look shortly.");
    }
  }

  // `userRow`, `isPrivileged`, `ttsMode` and `charLimit` are already resolved
  // above (character-limit block, ahead of message sanitization); the ban
  // check, the blocklist and the length check all ran between there and here
  // — reused, not re-read or recomputed.
  const usernameColor: string | null = userRow.rows[0]?.username_color ?? null;
  const usernameStyle: object | null = userRow.rows[0]?.username_style ?? null;
  const displayName: string | null = userRow.rows[0]?.display_name ?? null;

  // ── `!` timer commands: a deprecation shim ──────────────────────────────────
  //
  // The timer and bar controls are `/timer …` and `/bar …` in the site command
  // tree (web/app/lib/commands/spec.ts); the old `!a/!s/!set/!start/!pause/
  // !reset/!cap/!hr/!fill` forms are refused here with the replacement named.
  //
  // It does NOT just fall through to "ordinary chat message": letting `!start`
  // through would post a bare "!start" to everyone AND silently not start the
  // timer. Refusing with the replacement named is the difference between a typo
  // and a marathon running unpaused.
  const tcmd = /^!(a|s|set|start|pause|reset|cap|hr|fill)\b/i.exec(message);
  if (tcmd && isPrivileged) {
    const was = (tcmd[1] ?? "").toLowerCase();
    const now: Record<string, string> = {
      a: "/timer add", s: "/timer sub", set: "/timer set",
      start: "/timer start", pause: "/timer pause", reset: "/bar reset",
      cap: "/timer cap", hr: "/bar hr", fill: "/bar fill",
    };
    return Response.json(
      { error: "command_moved", message: `!${was} is now ${now[was]} — type / to see them all` },
      { status: 400 }
    );
  }

  // Slow mode (site-wide singleton, mod-set): non-mods must wait N seconds
  // between accepted messages. Enforced AFTER the command short-circuits above —
  // a pronoun/timer command isn't a chat message and doesn't consume the window.
  if (!isPrivileged) {
    // Effective wait = max(global, per-user): a per-user entry can only ever make
    // someone SLOWER than the room, never faster. Both share one window, so a
    // limited user is not charged twice for the same message.
    const [globalSlow, perUser] = await Promise.all([currentSlowMode(), currentUserSlowModes()]);
    const slowSeconds = Math.max(globalSlow, perUser.get(matrixId) ?? 0);
    if (slowSeconds > 0) {
      const now = Date.now();
      // Opportunistic eviction, same idea as rateMap: don't grow forever.
      if (lastSlowSend.size > 5000) {
        for (const [k, t] of lastSlowSend) {
          if (now - t >= slowSeconds * 1000) lastSlowSend.delete(k);
        }
      }
      const last = lastSlowSend.get(matrixId) ?? 0;
      const remainingMs = last + slowSeconds * 1000 - now;
      if (remainingMs > 0) {
        return Response.json(
          { error: "slow_mode", retryAfterSeconds: Math.ceil(remainingMs / 1000), slowModeSeconds: slowSeconds },
          { status: 429 }
        );
      }
      lastSlowSend.set(matrixId, now);
    }
  }

  // ── Chat spends: highlight (50) and read-aloud (150) ────────────────────────
  // Runs the full gauntlet above (rate limit, sanitize, blacklist, ban, slow
  // mode) like any message, then debit → card. Native-only: a bought message is
  // a site celebration, never cross-posted (destination toggle and reply are
  // ignored; the composer suspends spend mode while replying). Unlike the
  // billing webhook's best-effort celebrations the card HERE is the product, so
  // the stream-api call is awaited and a failure refunds the debit.
  //
  // These are PRICES, not floors: a viewer is never charged a price they were
  // not shown, so the price guard runs on both.
  const spendReq = body.spend as { mode?: unknown; spendId?: unknown; expectedPrice?: unknown } | undefined;
  if (spendReq && typeof spendReq === "object") {
    const mode = spendReq.mode === "highlight" || spendReq.mode === "tts" ? spendReq.mode : null;
    const spendId = typeof spendReq.spendId === "string" ? spendReq.spendId.slice(0, 64) : "";
    if (!mode || spendId.length < 8) {
      return Response.json({ error: "bad_spend" }, { status: 400 });
    }

    // Before the debit, so a spend refused for its price never charges.
    // Two literal getPrice calls rather than getPrice(mode): a variable
    // lookup is invisible to storeSpendGuard.test.ts, which greps this file to
    // prove the route is guarded at all. Keep both literals.
    const current = mode === "highlight"
      ? await storePricing.getPrice("highlight")
      : await storePricing.getPrice("tts");
    const guard = priceGuard(spendReq.expectedPrice, current);
    if (!guard.ok) {
      return Response.json({ error: guard.error, price: guard.price }, { status: guard.status });
    }
    const price = guard.price;

    const debit = await debitCoins({
      matrixId,
      amount: price,
      sink: mode === "highlight" ? "highlight" : "tts",
      ref: spendId,
      meta: { message: message.slice(0, 100) },
    });
    if (!debit.ok) {
      return Response.json({ error: "insufficient_coins" }, { status: 402 });
    }
    // A replayed spendId means the FIRST request already posted the card (or
    // refunded itself) — acknowledge without double-carding.
    if (debit.replay) {
      return Response.json({ ok: true, spent: price, balance: debit.balance });
    }

    const delivery = await deliverChatEvent({
      kind: mode === "highlight" ? "highlight" : "tts_msg",
      username: displayName,
      // The field is named for the cheer it was built for and carries the
      // spender for three kinds. Renaming it ripples through chat.js's
      // persistence, the history route and the WS frame for no behaviour
      // change — leave it.
      //
      // BUT the two kinds here don't read the SAME field. `highlight` shares
      // alert.js's cheer/highlight card branch, which destructures
      // cheererMatrixId; `tts_msg` has its own branch, which destructures
      // senderMatrixId — a different name, inherited from the sticker/sound
      // family it was built alongside. Sending one name for both silently drops
      // the spender's identity for whichever kind doesn't read it (a read-aloud
      // card with no badges/avatar/user-card, and a persisted site.chat_messages
      // row with matrix_id NULL). So this branches instead of picking one name.
      ...(mode === "highlight" ? { cheererMatrixId: matrixId } : { senderMatrixId: matrixId }),
      usernameColor,
      usernameStyle,
      coins: price,
      message,
      label: "",
      spendId,
    });

    if (delivery.outcome === "unconfirmed") {
      // NO refund — the card may have posted; refunding an unconfirmed spend is
      // the double-credit (see chatEventDelivery.ts).
      console.error("[chat/send] unconfirmed spend — coins kept, mode:", mode, "spendId:", spendId);
      return Response.json({ error: "spend_unconfirmed" }, { status: 502 });
    }
    if (delivery.outcome !== "delivered") {
      await refundCoins({
        matrixId,
        amount: price,
        ref: spendId,
        meta: { reason: delivery.outcome === "refused" ? `refused_${delivery.status}` : "stream-api unreachable" },
      }).catch((e) => console.error("[chat/send] spend refund failed:", e));
      return Response.json({ error: "spend_failed" }, { status: 502 });
    }
    // A read-aloud that was never spoken is not the product. money.js
    // (`spoken = !!(ALERT_TTS_ENABLED && cleanForTTS(message))`) returns
    // spoken:false when ALERT_TTS_ENABLED is off, or — the reachable one in
    // practice — when cleanForTTS (alert.js) strips every word: a link-only or
    // emote-only message leaves nothing to say. NOT the blacklist mask: it
    // substitutes equal-length asterisks and can never empty a string.
    // refundFlag is what makes that honest.
    if (mode === "tts" && delivery.body.spoken === false) {
      await refundCoins({
        matrixId,
        amount: price,
        ref: spendId,
        meta: { reason: "not_spoken" },
      }).catch((e) => console.error("[chat/send] tts refund failed:", e));
      return Response.json({ error: "not_spoken" }, { status: 502 });
    }
    maybeEarnChatCoin(matrixId);
    return Response.json({ ok: true, spent: price, balance: debit.balance });
  }

  // Canonical stream identity — passed to /chat/native on an "all" send so
  // stream-api can key its echo-dedup window on it (canonicalId + message text).
  const linkRow = await reads.link;
  const canonicalId: string | null = linkRow.rows[0]?.canonical_id ?? null;

  // A reply targets ONE person on ONE platform. `isReply` (any origin, incl.
  // native/relay) forbids fan-out entirely; `isReplyRoutable` says whether that
  // origin is a cross-postable platform (else the reply stays native-only).
  const isReply = reply_to_id != null;
  // Routable = we can ACTUALLY cross-post there right now (canCrossPost, not just
  // "known platform"). A reply to a platform in CROSSPOST_DISABLED must fall
  // through to native site chat, never attempt a platform send. Using canCrossPost
  // here also keeps such replies out of the featured-community routing block
  // (which could 409 and drop the message).
  const isReplyRoutable = !!(reply_to_platform && canCrossPost(reply_to_platform));
  // reply_to_id is a FK into site.chat_messages — valid ONLY for native
  // messages. A reply to a PLATFORM message carries that platform's stream.chat_log
  // id, which violates the FK (row silently dropped → message "disappears") or, on
  // an id collision, threads to the wrong message. Keep the quoted username/text
  // (the visual "↩ …" context) but null the id for non-native origins.
  const replyIsNative =
    reply_to_platform == null || isNativePlatform(reply_to_platform);
  // A reply to a SITE message quotes the stored row, not what the client sent.
  // The stored message is the public text — a redacted part is placeholder
  // glyphs there — so a Supporter replying to a message they had just opened
  // can never carry its hidden words into a quote everyone sees.
  // Platform-origin replies keep the client's text: nothing on them is hidden.
  let quoteText = reply_to_text;
  if (isReply && replyIsNative && Number.isInteger(Number(reply_to_id)) && Number(reply_to_id) > 0) {
    const { rows: q } = await pool
      // Only a VISIBLE message can be quoted: a deleted one (or an account deletion's kept
      // evidence) must not be copied into a reply everyone sees.
      .query<{ message: string }>(`SELECT m.message FROM site.chat_messages m WHERE m.id = $1 AND ${messageVisibleSql("m")}`, [Number(reply_to_id)])
      .catch(() => ({ rows: [] as { message: string }[] }));
    // A quote of a message that is no longer visible carries nothing, whatever the client sent.
    quoteText = q[0] ? q[0].message.slice(0, 100) : null;
  }
  const replyMeta = isReply
    ? { reply_to_id: replyIsNative ? reply_to_id : null, reply_to_username, reply_to_text: quoteText }
    : {};

  // "All platforms": fan out to every linked platform once each, to the home
  // channel, AND write ONE canonical native row so the message shows exactly
  // once on the site as the user's website message — stream-api's allSendDedup
  // suppresses the per-platform echoes that follow (keyed on canonicalId + text).
  //
  // BUT NOT when replying: a reply must go ONLY to where the person you're
  // replying to is — never broadcast into channels they aren't in. ANY reply
  // (even to a native/relay message, which isn't routable) skips the fan-out and
  // falls through to the single-target path below (→ that platform, or native).
  // ── Whole-message redaction: the lock toggle and `/redact` ─────────────────
  //
  // Native-only by construction, and shaped like the cheer above: run the full
  // gauntlet (rate limit, sanitize, WORD BLOCKLIST, ban, slow mode) exactly like
  // any message, then return early rather than falling through to the routing
  // below. Placed HERE rather than beside the cheer only because it needs
  // `replyMeta`, computed just above.
  //
  // The blocklist ran on the PLAINTEXT at the top of this route (`message` is
  // `red.plain`). That is the whole reason redaction is not a way to smuggle
  // banned words past the filter.
  //
  // PARTIAL redaction (`||marks||`) does NOT return here — it falls through to
  // the normal routing below, which posts `red.publicText` to the site and
  // `red.platformText` ("[REDACTED]" in place of each hidden part) to
  // platforms. Only a whole-message redaction stays on the site.
  //
  // WHOLE REDACTION WINS OVER REPLY ROUTING. A reply normally overrides the sticky
  // destination and posts to the replied-to person's platform; here it must not,
  // because that would silently send in CLEAR TEXT the message a user asked to
  // encrypt — a downgrade attack by UI accident. The reply's quote is kept (and
  // reply_to_id is already nulled for non-native origins by replyIsNative), so
  // the message still reads as a reply on the site; it simply never leaves.
  if (wholeRedact) {
    // An explicit platform destination alongside `encrypted` is contradictory
    // input, not something to silently resolve — the composer never sends it.
    if (forced_destination) {
      return Response.json({ error: "encrypted_native_only" }, { status: 400 });
    }
    // Supporter + credit were checked at the redaction gates above (a whole
    // redaction always has something to hide, so `red.redacted` held).

    // The placeholder is the message as far as every other system is concerned.
    const encRes = await streamApiFetch(`/chat/native`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matrixId,
        username: displayName,
        message: red.publicText,
        ...redactExtra,
        usernameColor,
        usernameStyle,
        ...replyMeta,
      }),
    }).catch(() => null);
    if (!encRes?.ok) return Response.json({ error: "send_failed" }, { status: 502 });

    maybeEarnChatCoin(matrixId);
    return Response.json({ ok: true, encrypted: true });
  }

  // ── Personal Twitch emotes ─────────────────────────────────────────────────
  // Words that are the SENDER's own Twitch emotes resolve into a per-message
  // map — the same msg.emotes mechanism platform messages already use — so
  // every viewer renders them. Only words ABSENT from the site manifest
  // resolve; that is the whole "site catalog wins collisions" rule.
  // Deliberately BELOW the encrypted early-return: the map's keys are
  // plaintext words, and an encrypted frame must never carry them (they'd sit
  // in the public WS history buffer). personalEmotesWiring.test.ts pins both
  // this position and the three attachment sites.
  // Skipped outright for a redacted message: the map's keys would be words
  // from the PLAINTEXT, hidden ones included. (Site-catalog emotes in the
  // visible part still render — the client resolves those from the manifest.)
  const personalEmotes: Record<string, string> | null = red.redacted ? null : await (async () => {
    const { emotes: personal } = await getPersonalEmotes(matrixId);
    if (Object.keys(personal).length === 0) return null;
    const catalog = new Set(Object.keys(await getManifest()));
    return resolveOutgoingEmotes(message, personal, catalog);
  })().catch(() => null);

  // ── Raid lockdown, outbound half ──────────────────────────────────────────
  // Computed HERE, above the fan-out, because there are TWO outbound paths
  // and they are easy to miss: this "all" branch, and the single-target path
  // further down. Gating only the second one would leave `send to: all`
  // broadcasting to every linked platform with the switch thrown —
  // lockdown.test.ts asserts the check precedes `sendToPlatform`.
  //
  // Only queried when a platform is actually in play, so an ordinary native
  // message still costs no extra round trip.
  const crosspostLocked =
    (forced_destination !== null || reply_to_platform !== null) && (await isCrosspostLocked());

  // ── Commands stay on the site ───────────────────────────────────────────────
  // `!…` is addressed to our own bot and `/…` to the destination platform;
  // relaying either fires other channels' bots or asks Twitch to ACT rather
  // than to post. Routed like a CROSSPOST_DISABLED target — null the platform
  // and let it fall through to native — so the message is still delivered
  // here rather than lost. See lib/outgoingText.
  const commandText = isPlatformCommand(message);

  if (forced_destination === "all" && !isReply && !crosspostLocked && !commandText) {
    // Fan out only to the platforms the user has actually linked AND can
    // cross-post to (excludes anything in CROSSPOST_DISABLED).
    // provider_account_id comes along for the ride: it is the sender's own id on
    // that platform, which is what stream-api uses to recognise an echo by WHO
    // sent it rather than only by what it says. Same query, no extra round trip.
    const { rows: linkRows } = await pool.query<{ provider: string; provider_account_id: string | null }>(
      `SELECT DISTINCT provider, provider_account_id FROM site.accounts
       WHERE matrix_id = $1 AND type IN ('oauth','atproto')`,
      [matrixId]
    );
    const linkedTargets = [...new Set(linkRows.map(r => r.provider))].filter(canCrossPost);
    // The sender's skip list can only take their OWN linked platforms out.
    const targets = linkedTargets.filter((p) => !skipPlatforms.has(p));
    const senderPlatformIds = Object.fromEntries(
      linkRows.flatMap((r) => (r.provider_account_id ? [[r.provider, r.provider_account_id]] : []))
    );
    if (linkedTargets.length === 0) {
      return Response.json({ error: "not_linked", platform: "all" }, { status: 403 });
    }
    // Every linked platform skipped: nothing to fan out to, so the line falls
    // through to the site-only path below — it still posts, quietly.
    if (targets.length > 0) {
      // Arm the echo-dedup window + render the ONE canonical native line BEFORE
      // fanning out. Platform bots echo the message back into stream-api seconds
      // later; registering first guarantees the window is armed before any echo
      // returns. The dedup keys on message TEXT (not canonicalId) because a
      // broadcaster's per-platform identities are often separate canonical users.
      const nativeRes = await streamApiFetch(`/chat/native`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matrixId: matrixId,
          username: displayName,
          message: red.publicText,
          ...redactExtra,
          usernameColor,
          usernameStyle,
          ...(personalEmotes ? { emotes: personalEmotes } : {}),
          allSend: true,
          canonicalId,
          expectedEchoes: targets.length,
          // What the platforms will echo back: "[REDACTED]" where a part was
          // hidden. Without it the echo key would be the placeholder text, which
          // no platform ever sends, and every copy would come back as a duplicate.
          ...(red.redacted ? { echoText: red.platformText } : {}),
          // Scope the echo window to the platforms we actually fan out to — an
          // unrelated viewer typing the same text elsewhere must not be swallowed.
          expectedPlatforms: targets,
          // The sender's account id on each platform. Lets stream-api hold the
          // echo window open far longer than a text guess safely allows, because a
          // viewer's message can never match it.
          senderPlatformIds,
          // Destination set for the indicator color cycle (persisted + broadcast
          // by stream-api). Intended targets — the native line renders before the
          // per-platform results are known.
          destPlatforms: targets,
          // "all" is offered from ONE linked platform. stream-api only stores
          // destPlatforms at ≥2 entries, so a single-target fan-out would render
          // a bare untinted native line — strictly worse than `send to:
          // <platform>`. Pass the one platform as destPlatform so the line keeps
          // the same tint that forcing it directly would get.
          ...(targets.length === 1 ? { destPlatform: targets[0] } : {}),
        }),
      }).catch(() => null);
      // The native row's id keys the copies mapping (site delete → platform copies).
      // A line that was only a poll vote has no id (nothing stored) — `nativeAnswer`.
      const nativeJson = nativeRes?.ok ? await nativeRes.json().catch(() => null) : null;
      const native = nativeAnswer(nativeJson);
      const siteMsgId = Number(native.id);
      const results = await Promise.all(
        targets.map(async (p) => {
          // sendToPlatform can throw (token decrypt / pool errors) — the native
          // line is already broadcast, so a throw here must degrade to a per-
          // platform failure, not 500 the route (user resends → visible dupe).
          // A timeout or our own throw is infrastructure — silent to the viewer.
          const r = await sendToPlatform(matrixId, p, red.platformText, reply_to_username ?? undefined)
            .catch((err): PlatformSendResult => {
              const f = thrownFailure(err);
              if (f.reason === "internal") console.warn(`[chat/send] ${p} send threw:`, err);
              return { ok: false, ...f };
            });
          // Registered HERE, inside the map, not after Promise.all below. This
          // platform's echo is already on its way; making it wait for the slowest
          // platform in the fan-out is what would let the duplicate through.
          if (r.ok && r.platformMsgId && Number.isInteger(siteMsgId)) {
            void registerEchoCopy(siteMsgId, [{ platform: p, platformMsgId: r.platformMsgId }]);
          }
          return { p, r };
        })
      );
      // Map the successful sends' platform message ids back to the native row so
      // a later site-side delete/purge can remove the cross-posted copies.
      if (Number.isInteger(siteMsgId)) {
        const copies = results.flatMap((x) =>
          x.r.ok && x.r.platformMsgId ? [{ platform: x.p, platformMsgId: x.r.platformMsgId }] : []);
        if (copies.length) void recordPlatformCopies(siteMsgId, copies);
      }
      const sent = results.filter(x => x.r.ok).map(x => x.p);
      for (const x of results) if (!x.r.ok) logCopyFailure(x.p, x.r, siteMsgId);
      // Every platform that did NOT take it, with why — a partial fan-out is reported,
      // never dropped: the sender sees "posted here, Kick refused it".
      const failed = results.flatMap((x) => (x.r.ok ? [] : [failureOf(x.p, x.r)]));
      const report = { posted: !!nativeRes?.ok, failed, ...native };
      const anyLinked = results.some(x => !(x.r.ok === false && x.r.error === "not_linked"));
      if (sent.length > 0) {
        maybeEarnChatCoin(matrixId);
        return Response.json({ sentTo: "all", platforms: sent, ...report });
      }
      if (!anyLinked) return Response.json({ error: "not_linked", platform: "all" }, { status: 403 });
      // Linked somewhere but nothing landed (channels offline, etc.)
      return Response.json({ error: "send_failed", platform: "all", ...report }, { status: 409 });
    }
  }

  // Single-target routing precedence:
  //  • a REPLY always wins → the replied-to person's platform (routable AND the
  //    sender has that account linked), else native-only. The "send to" toggle
  //    is ignored while replying — you answer the person where they are, not
  //    where the sticky toggle points.
  //  • otherwise → the forced single platform from the toggle (or native).
  //
  // The linkage pre-check matters: without it, a reply to (say) a YouTube
  // message from someone with no YouTube linked would render a youtube-tinted
  // native line, then 403 not_linked — a confusing error for a message that
  // visibly posted. The reply goes out with *that* account if linked; if not, it
  // just sends to the site.
  let replyLinked = false;
  if (isReply && isReplyRoutable) {
    const { rows: rl } = await pool.query(
      `SELECT 1 FROM site.accounts
       WHERE matrix_id = $1 AND provider = $2 AND type IN ('oauth','atproto') LIMIT 1`,
      [matrixId, reply_to_platform]
    );
    replyLinked = rl.length > 0;
  }
  // A skipped destination is the site line alone — not an explicit destination,
  // so no 409 per message for a refusal already explained.
  const forcedSingle = forced_destination && forced_destination !== "all" && !skipPlatforms.has(forced_destination) ? forced_destination : null;
  const requestedTarget = isReply
    // A reply to someone on a platform the sender skips stays on the site, like a
    // reply to a platform they have not linked.
    ? (isReplyRoutable && replyLinked && !skipPlatforms.has(reply_to_platform!) ? reply_to_platform : null)
    : forcedSingle;

  // Nulling the target routes this down the SAME path as a CROSSPOST_DISABLED
  // platform, which already degrades to native rather than erroring — so a
  // locked message is still delivered on the site instead of being lost.
  // Explicit destinations additionally get a 409 at the bottom, because
  // silently keeping a message you asked to send to Twitch is a lie.
  // (`crosspostLocked` is computed above the "all" fan-out — see there.)
  const platformTarget = crosspostLocked || commandText ? null : requestedTarget;
  // An explicit toggle destination means the user wants it THERE: surface failures
  // instead of silently rerouting to native. Replies stay implicit (native
  // fallback) so a reply is delivered on-site even if the platform send fails.
  const explicitDestination = !isReply && forcedSingle !== null;
  // Only attempt a platform send to a cross-postable target. A reply to a
  // non-cross-postable platform (CROSSPOST_DISABLED) falls through to native so
  // the reply is still delivered on the site instead of erroring.
  if (platformTarget && canCrossPost(platformTarget)) {
    // When a community streamer is featured (the streamer offline), route outbound chat
    // to THEIR channel — resolved server-side from the current selection, never
    // from client input. If they aren't on the chosen platform, refuse rather
    // than silently posting into the streamer's channel.
    let target: SendTarget | undefined;
    const status = await getStreamStatus();
    if (!status.live && status.community) {
      const c = status.community;
      if (platformTarget === "youtube" && c.youtube_channel_id) target = { youtubeChannelId: c.youtube_channel_id };
      else if (platformTarget === "twitch" && c.twitch_login) target = { twitchLogin: c.twitch_login };
      else {
        return Response.json(
          { error: "not_featured_platform", platform: platformTarget, featured: c.display_name },
          { status: 409 }
        );
      }
    }
    // Render the message ONCE on the site as the user's own site message —
    // tinted with the destination platform (destPlatform) so it reads as "sent to
    // Twitch" while keeping site identity/badges — and arm echo-suppression for
    // the platform copy that bounces back. Same mechanism as "send to all"
    // (allSendDedup keyed on message text), with a single expected echo.
    //
    // YouTube strips its own >20-char emote-name tokens (they never render there
    // — see stripLongEmoteNames); this is a SINGLE destination so it's safe to
    // pre-strip before arming the echo key too (unlike the "all" fan-out below,
    // where one armed key is shared across platforms that each get the raw
    // text — stripping only YouTube's copy there would desync the dedup key and
    // leak a duplicate line, so that path deliberately doesn't strip).
    // `red.platformText`, never `message`: a platform gets "[REDACTED]" where a
    // part was hidden (for an ordinary message the two are identical).
    const outgoingMessage = platformTarget === "youtube" ? await stripLongEmoteNames(red.platformText) : red.platformText;

    // A reply to a Twitch/Kick-origin message can thread natively (their send
    // APIs accept the target's own platform message id) instead of relying on
    // the "@user " text-prefix hack. `reply_to_id` here is the RAW client value
    // — for a platform-origin target it's that platform's stream.chat_log row
    // id (see replyIsNative above), which is exactly what's needed to look up
    // the native platform_msg_id. Falls back to the prefix hack (YouTube always,
    // or if this message predates platform_msg_id capture / lookup misses).
    let replyParentId: string | undefined;
    if (isReply && (platformTarget === "twitch" || platformTarget === "kick") && reply_to_id != null) {
      const { rows: pr } = await pool.query<{ platform_msg_id: string | null }>(
        `SELECT platform_msg_id FROM stream.chat_log WHERE id = $1 AND platform = $2 LIMIT 1`,
        [reply_to_id, platformTarget]
      ).catch(() => ({ rows: [] as { platform_msg_id: string | null }[] }));
      replyParentId = pr[0]?.platform_msg_id ?? undefined;
    }

    // The sender's own id on the destination platform (see the allSend path).
    // Best-effort: without it the echo window falls back to the text guess.
    const { rows: sidRows } = await pool.query<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM site.accounts
       WHERE matrix_id = $1 AND provider = $2 AND type IN ('oauth','atproto') LIMIT 1`,
      [matrixId, platformTarget]
    ).catch(() => ({ rows: [] as { provider_account_id: string | null }[] }));
    const singleSenderPlatformId = sidRows[0]?.provider_account_id ?? null;

    // This MUST happen BEFORE sendToPlatform: the broadcaster's own message
    // echoes back through stream-ingest within tens of ms, which beats arming if
    // we wait for the send to return — leaking the duplicate platform line. The
    // allSend path arms before fan-out for the same reason. Cost: the native line
    // shows even if the platform send then fails (matches allSend; the user still
    // gets an error toast, and the message isn't lost).
    const singleNativeRes = await streamApiFetch(`/chat/native`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matrixId: matrixId,
        username: displayName,
        message: red.publicText,
        ...redactExtra,
        usernameColor,
        usernameStyle,
        ...(personalEmotes ? { emotes: personalEmotes } : {}),
        allSend: true,
        canonicalId,
        expectedEchoes: 1,
        expectedPlatforms: [platformTarget],
        // See the allSend path: the sender's own id on this platform is what
        // lets stream-api recognise the echo by sender instead of by text.
        ...(singleSenderPlatformId
          ? { senderPlatformIds: { [platformTarget]: singleSenderPlatformId } }
          : {}),
        destPlatform: platformTarget,
        // A native-threaded reply is SENT as the bare message (the platform's own
        // reply UI carries the "@user" context, not the text we send) — but what
        // comes BACK varies by platform: Twitch's Send Chat Message API
        // prepends "@user " to the delivered/echoed text when
        // reply_parent_message_id is set, so a bare-text-only dedup key misses
        // and renders a duplicate row. Since we can't be sure which shape a given
        // platform echoes, arm BOTH — echoText (bare) and echoTextAlt
        // (@-prefixed) — so stream-api's dedup matches whichever one actually
        // comes back. The text-prefix fallback (no native threading) only ever
        // echoes prefixed, so it needs no alt.
        echoText: replyParentId ? outgoingMessage : platformOutgoingText(outgoingMessage, reply_to_username),
        ...(replyParentId && { echoTextAlt: platformOutgoingText(outgoingMessage, reply_to_username) }),
        ...replyMeta,
      }),
    }).catch(() => null);
    const singleNativeJson = singleNativeRes?.ok ? await singleNativeRes.json().catch(() => null) : null;
    const singleNative = nativeAnswer(singleNativeJson);
    const singleSiteMsgId = Number(singleNative.id);
    const singlePosted = !!singleNativeRes?.ok;

    const result = await sendToPlatform(matrixId, platformTarget, outgoingMessage, reply_to_username ?? undefined, target, replyParentId)
      .catch((err): PlatformSendResult => {
        const f = thrownFailure(err);
        if (f.reason === "internal") console.warn(`[chat/send] ${platformTarget} send threw:`, err);
        return { ok: false, ...f };
      });
    if (!result.ok) logCopyFailure(platformTarget, result, singleSiteMsgId);
    if (result.ok) {
      // Tie the platform copy back to the native row (site delete → copy delete).
      if (result.platformMsgId && Number.isInteger(singleSiteMsgId)) {
        const copy = [{ platform: platformTarget, platformMsgId: result.platformMsgId }];
        void recordPlatformCopies(singleSiteMsgId, copy);
        void registerEchoCopy(singleSiteMsgId, copy);
      }
      maybeEarnChatCoin(matrixId);
      return Response.json({ sentTo: platformTarget, ...singleNative });
    }
    if (result.error === "not_linked") {
      return Response.json({ error: "not_linked", platform: platformTarget }, { status: 403 });
    }
    // The site line was posted above, before the platform answered — so this is
    // "posted here, not there", and the report says which, and why.
    const singleReport = { posted: singlePosted, failed: [failureOf(platformTarget, result)], ...singleNative };
    // Explicitly toggled destination: tell the user it didn't land. (Common case:
    // the broadcast is only "upcoming", so YouTube's API 404s live chat until the
    // stream starts.)
    if (explicitDestination) {
      return Response.json(
        { error: result.error, platform: platformTarget, ...(result.reason ? { reason: result.reason } : {}), ...singleReport },
        { status: 409 },
      );
    }
    // Reply-routing fallback: the reply is on the site (don't double-write via the
    // bottom native path), and the sender is still told it didn't reach the platform.
    maybeEarnChatCoin(matrixId);
    return Response.json({ ok: true, ...singleReport });
  }

  // .catch → null: during a stream-api restart this fetch REJECTS (it does
  // not return a non-ok Response), and this is the most common send shape —
  // without the catch every deploy would surface raw 500s instead of the
  // designed 502 the composer maps to draft-restoring feedback.
  const res = await streamApiFetch(`/chat/native`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      matrixId: matrixId,
      username: displayName,
      message: red.publicText,
      ...redactExtra,
      usernameColor,
      usernameStyle,
      ...(personalEmotes ? { emotes: personalEmotes } : {}),
      ...replyMeta,
    }),
  }).catch(() => null);

  if (!res?.ok) {
    // A line that was a poll vote stream-api could not store: neither counted nor shown.
    const err = res ? await res.json().catch(() => null) as { error?: string } | null : null;
    if (err?.error === "vote_failed") return Response.json({ error: "vote_failed" }, { status: 503 });
    return new Response("Failed to send", { status: 502 });
  }
  maybeEarnChatCoin(matrixId);
  // The line was only an option number of the running poll: counted as a vote, not
  // shown — the composer says so, or the sender would think it was dropped.
  const plain = nativeAnswer(await res.json().catch(() => null));
  if (plain.pollVote) return Response.json({ ok: true, pollVote: plain.pollVote });
  const plainReport = { posted: true, ...(plain.id != null ? { id: plain.id } : {}) };
  const blockedTarget = requestedTarget ?? forced_destination ?? NATIVE_PLATFORM;
  // The message IS on the site by now — this 409 says "it didn't leave the
  // site", not "it was lost". Mirrors how an explicitly-toggled destination
  // already reports a failed platform send. Implicit reply-routing stays quiet
  // and falls through to native, exactly as CROSSPOST_DISABLED does.
  // `forced_destination === "all"` is explicit too, but carries no
  // `forcedSingle`, so `explicitDestination` alone would let the fan-out case
  // fall through silently — the user would think it went to four platforms.
  const blockedAll = crosspostLocked && forced_destination === "all" && !isReply;
  if (crosspostLocked && (explicitDestination || blockedAll)) {
    return Response.json(
      { error: "crosspost_locked", platform: requestedTarget ?? forced_destination, ...plainReport, failed: [{ platform: blockedTarget, error: "crosspost_locked" }] },
      { status: 409 }
    );
  }
  // Same principle for a command the sender explicitly aimed at a platform:
  // the message IS delivered here, but saying nothing would let them believe it
  // reached Twitch. An implicit reply stays quiet, as above.
  if (commandText && (explicitDestination || (forced_destination === "all" && !isReply))) {
    return Response.json(
      { error: "command_native_only", platform: requestedTarget ?? forced_destination, ...plainReport, failed: [{ platform: blockedTarget, error: "command_native_only" }] },
      { status: 409 }
    );
  }
  return new Response("OK");
}
