import { getStreamStatus } from "@/app/lib/streamStatus";
import { requireUser } from "@/app/lib/authGuard";
import { earn } from "@/app/lib/coinsServer";

export const runtime = "nodejs";

// POST /api/points/heartbeat → { balance, awarded, watchPoints, capped, live }
// Watch-time earn: the client beats every ~60s while signed in, the stream is
// live, and the tab is visible. Liveness is verified SERVER-side (getStreamStatus
// is cached ~5s and shared across callers, so this is cheap) and the per-beat
// delta is clamped in coinsServer from the STORED last_beat — the client never
// supplies elapsed time, and replayed or multi-tab beats collapse to real
// elapsed time. Off-stream beats are acknowledged without accrual so the client
// doesn't need its own live check.
//
// `balance` is null when the beat awarded nothing (most beats — a coin is ten
// minutes apart). The client already treats a non-number as "no change".
export async function POST() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const status = await getStreamStatus();
  if (!status.live) return Response.json({ balance: null, earnedToday: null, live: false });

  const r = await earn.recordWatchHeartbeat(matrixId);
  return Response.json({ ...r, live: true });
}
