import { getChatIdentity } from "@/app/lib/chatIdentity";
import { requireUser } from "@/app/lib/authGuard";
import { getManifest } from "@/app/api/emotes/route";
import { debitCoins, refundCoins } from "@/app/lib/coinsServer";
import { storePricing } from "@/app/lib/storePricingServer";
import { priceGuard } from "@/app/lib/storePricing";
import { deliverChatEvent } from "@/app/lib/chatEventDelivery";
import { stickerResEmoteUrl } from "@/app/lib/emoteRes";
import { createCooldown } from "@/app/lib/rateLimit";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Global sticker throttle — one on-stream sticker per 10s across ALL users (the
// overlay queues, but a flood shouldn't monopolize the stream). In-process map
// like chat/send's rateMap; single web process.
let lastStickerTs = 0;
const STICKER_GAP_MS = 10_000;

// Per-user cooldown on top of the global throttle — the global gap alone still
// lets one user hog every slot back-to-back. Armed only after a successful
// debit (a rejected/replayed spend shouldn't start the gap).
const userCooldown = createCooldown(7_000);

// POST /api/points/spend/sticker { emoteName, spendId, expectedPrice } → { ok, balance }
// Big-emote spend: the emote name is resolved against the server's own manifest
// (client URLs are never trusted onto the stream overlay), debit, then the
// awaited stream-api card + showSticker frame; refund if the effect fails.
//
// The charge comes from site.store_prices, never from a constant, and
// `expectedPrice` must match it — see priceGuard in app/lib/storePricing.ts.
// A viewer is never charged a price they were not shown.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const emoteName = typeof (body as { emoteName?: unknown } | null)?.emoteName === "string"
    ? (body as { emoteName: string }).emoteName.slice(0, 100) : "";
  const rawSpend = (body as { spendId?: unknown } | null)?.spendId;
  const spendId = typeof rawSpend === "string" ? rawSpend.slice(0, 64) : "";
  if (!emoteName || spendId.length < 8) return new Response("Bad Request", { status: 400 });

  const manifest = await getManifest();
  const emote = manifest[emoteName];
  if (!emote?.url) return Response.json({ error: "unknown_emote" }, { status: 404 });

  // Before the throttles and before any debit: a spend that is going to be
  // refused for its price should never arm a cooldown the viewer then has to
  // wait out for a purchase that never happened.
  const guard = priceGuard(
    (body as { expectedPrice?: unknown } | null)?.expectedPrice,
    await storePricing.getPrice("sticker")
  );
  if (!guard.ok) {
    return Response.json({ error: guard.error, price: guard.price }, { status: guard.status });
  }
  const price = guard.price;

  const now = Date.now();
  if (now - lastStickerTs < STICKER_GAP_MS) {
    return Response.json(
      { error: "throttled", retryAfterSeconds: Math.ceil((STICKER_GAP_MS - (now - lastStickerTs)) / 1000) },
      { status: 429 }
    );
  }
  const userRemainingMs = userCooldown.remainingMs(matrixId);
  if (userRemainingMs > 0) {
    return Response.json(
      { error: "throttled", retryAfterSeconds: Math.ceil(userRemainingMs / 1000) },
      { status: 429 }
    );
  }

  const identity = await getChatIdentity(matrixId);
  const username = identity.username;

  const debit = await debitCoins({
    matrixId, amount: price, sink: "sticker", ref: spendId, meta: { emote: emoteName },
  });
  if (!debit.ok) return Response.json({ error: "insufficient_coins" }, { status: 402 });
  if (debit.replay) return Response.json({ ok: true, balance: debit.balance });

  lastStickerTs = now;
  userCooldown.arm(matrixId);
  const delivery = await deliverChatEvent({
    kind: "sticker",
    username,
    senderMatrixId: matrixId,
    usernameColor: identity.usernameColor,
    usernameStyle: identity.usernameStyle,
    emoteName,
    emoteUrl: stickerResEmoteUrl(emote.url),
    coins: price,
    spendId,
  });
  if (delivery.outcome === "unconfirmed") {
    // NO refund: the deadline aborts our WAIT, not stream-api's WORK — the
    // sticker may well have appeared and credited the bar, and refunding an
    // unconfirmed spend would be exactly a double-credit.
    // The spendId outcome recorded on stream-api keeps a later manual refund
    // safe if it truly never ran.
    console.error("[spend/sticker] unconfirmed delivery — coins kept, spendId:", spendId);
    return Response.json({ error: "sticker_unconfirmed" }, { status: 502 });
  }
  if (delivery.outcome !== "delivered") {
    await refundCoins({ matrixId, amount: price, ref: spendId,
      meta: { reason: delivery.outcome === "refused" ? `refused_${delivery.status}` : "stream-api unreachable" } })
      .catch((e) => console.error("[spend/sticker] refund failed:", e));
    return Response.json({ error: "sticker_failed" }, { status: 502 });
  }

  return Response.json({ ok: true, balance: debit.balance });
}
