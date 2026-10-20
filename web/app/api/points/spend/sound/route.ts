import { getChatIdentity } from "@/app/lib/chatIdentity";
import { requireUser } from "@/app/lib/authGuard";
import { debitCoins, refundCoins } from "@/app/lib/coinsServer";
import { streamApiFetch } from "@/app/lib/streamApi";
import { deliverChatEvent } from "@/app/lib/chatEventDelivery";
import { getStreamStatus } from "@/app/lib/streamStatus";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Global sound throttle — one clip per 15s across all users (clips serialize on
// the stream PC anyway; don't let a flood build a minutes-long backlog).
let lastSoundTs = 0;
const SOUND_GAP_MS = 15_000;

// Short-lived manifest cache (the clip list changes ~never mid-session).
let manifestCache: { sounds: { id: string; label: string; price: number }[]; enabled: boolean; ts: number } | null = null;
const MANIFEST_TTL = 60_000;

async function getSounds() {
  if (manifestCache && Date.now() - manifestCache.ts < MANIFEST_TTL) return manifestCache;
  const res = await streamApiFetch("/sounds/manifest").catch(() => null);
  const d = res?.ok ? ((await res.json().catch(() => null)) as { enabled?: boolean; sounds?: { id: string; label: string; price: number }[] } | null) : null;
  manifestCache = { enabled: !!d?.enabled, sounds: d?.sounds ?? [], ts: Date.now() };
  return manifestCache;
}

// POST /api/points/spend/sound { soundId, spendId } → { ok, balance }
// Curated soundboard clip on stream. Price comes from the stream-api manifest;
// a clip that fails to play (gate off, missing file) refunds — see /chat/event.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const soundId = typeof (body as { soundId?: unknown } | null)?.soundId === "string"
    ? (body as { soundId: string }).soundId.slice(0, 60) : "";
  const rawSpend = (body as { spendId?: unknown } | null)?.spendId;
  const spendId = typeof rawSpend === "string" ? rawSpend.slice(0, 64) : "";
  if (!soundId || spendId.length < 8) return new Response("Bad Request", { status: 400 });

  const m = await getSounds();
  const clip = m.sounds.find((s) => s.id === soundId);
  if (!m.enabled || !clip) return Response.json({ error: "sound_unavailable" }, { status: 409 });

  // Clips only while LIVE — same reasoning as paid TTS (audio plays on the
  // stream PC's speakers regardless of OBS; no 3am soundboard).
  const status = await getStreamStatus();
  if (!status.live) return Response.json({ error: "stream_offline" }, { status: 409 });

  const now = Date.now();
  if (now - lastSoundTs < SOUND_GAP_MS) {
    return Response.json(
      { error: "throttled", retryAfterSeconds: Math.ceil((SOUND_GAP_MS - (now - lastSoundTs)) / 1000) },
      { status: 429 }
    );
  }

  const identity = await getChatIdentity(matrixId);
  const username = identity.username;

  const debit = await debitCoins({
    matrixId, amount: clip.price, sink: "sound", ref: spendId, meta: { sound: soundId },
  });
  if (!debit.ok) return Response.json({ error: "insufficient_coins" }, { status: 402 });
  if (debit.replay) return Response.json({ ok: true, balance: debit.balance });

  lastSoundTs = now;
  const delivery = await deliverChatEvent({
    kind: "sound",
    username,
    senderMatrixId: matrixId,
    usernameColor: identity.usernameColor,
    usernameStyle: identity.usernameStyle,
    coins: clip.price,
    soundId,
    label: clip.label,
    spendId,
  });
  if (delivery.outcome === "unconfirmed") {
    // NO refund — the clip may have played; refunding an unconfirmed spend is
    // the double-refund shape (see chatEventDelivery.ts). A deduped retry
    // replays the real `played` flag, so a truthful refund stays reachable.
    console.error("[spend/sound] unconfirmed delivery — coins kept, spendId:", spendId);
    return Response.json({ error: "sound_unconfirmed" }, { status: 502 });
  }
  if (delivery.outcome === "delivered" && delivery.body.ok === true && delivery.body.played !== false) {
    return Response.json({ ok: true, balance: debit.balance });
  }
  // Delivered-but-not-played (the refundFlag contract), refused, or never left
  // — all provably uncredited; refund as before.
  const notPlayed = delivery.outcome === "delivered";
  await refundCoins({ matrixId, amount: clip.price, ref: spendId,
    meta: { reason: notPlayed ? "sound_unavailable" : delivery.outcome === "refused" ? `refused_${delivery.status}` : "stream-api unreachable" } })
    .catch((e) => console.error("[spend/sound] refund failed:", e));
  return Response.json({ error: notPlayed ? "sound_unavailable" : "sound_failed" }, { status: notPlayed ? 409 : 502 });
}
