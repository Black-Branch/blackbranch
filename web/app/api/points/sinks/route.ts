import { streamApiFetch } from "@/app/lib/streamApi";
import { getStreamStatus } from "@/app/lib/streamStatus";

export const runtime = "nodejs";

// GET /api/points/sinks → { tts: {enabled}, sounds: {enabled, sounds} }
// Availability for the store's Spend tab: a paid effect that can't run right
// now (TTS gate off, no sound clips) renders greyed with a reason instead of
// letting anyone attempt a spend that would only be refunded. Public read —
// it exposes no user data. Cached briefly server-side.
let cache: { body: unknown; ts: number } | null = null;
const TTL = 30_000;

export async function GET() {
  if (cache && Date.now() - cache.ts < TTL) return Response.json(cache.body as object);
  const [ttsRes, soundRes, status] = await Promise.all([
    streamApiFetch("/tts/status").catch(() => null),
    streamApiFetch("/sounds/manifest").catch(() => null),
    getStreamStatus().catch(() => null),
  ]);
  const tts = ttsRes?.ok ? await ttsRes.json().catch(() => null) : null;
  const sounds = soundRes?.ok ? await soundRes.json().catch(() => null) : null;
  const body = {
    // Paid TTS requires the gate AND a live stream (audio plays on the stream
    // PC's speakers regardless of OBS — see spend/tts).
    tts: { enabled: !!tts?.enabled && !!status?.live },
    sounds: { enabled: !!sounds?.enabled, sounds: sounds?.sounds ?? [] },
  };
  cache = { body, ts: Date.now() };
  return Response.json(body);
}
