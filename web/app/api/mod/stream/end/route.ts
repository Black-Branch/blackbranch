import { requireMod } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { appendModLog } from "@/app/lib/modlog";

// POST /api/mod/stream/end — mod "force offline" override. Ends the current open
// stream session in stream-api so the site stops showing LIVE immediately
// (complements the heartbeat auto-recovery in /stream/current — this is the
// manual kill switch). No-op (still 200) when nothing is live.
export async function POST() {
  const me = await requireMod();
  if (me instanceof Response) return me;

  // A failed read is NOT a negative answer (sessionDecision's rule):
  // collapsing "couldn't ask" into the no-op below would tell a mod the
  // stream was already off while the site kept showing LIVE — exactly when
  // stream-api being unreachable is why they reached for the kill switch.
  const cur = await streamApiFetch(`/stream/current`, { cache: "no-store" } as RequestInit).catch(() => null);
  if (!cur || !cur.ok) {
    return Response.json({ error: "Couldn't reach the stream service — try again" }, { status: 502 });
  }
  const data = await cur.json().catch(() => null);
  if (!data) {
    return Response.json({ error: "Couldn't reach the stream service — try again" }, { status: 502 });
  }
  if (!data.live || !data.streamId) {
    return Response.json({ live: false, ended: false });
  }

  // `forced` + `by`: stream-api remembers a forced end and reports it on
  // /stream/current, so the poller HOLDS instead of re-opening a phantom
  // second session on its next tick while any platform still says live.
  const res = await streamApiFetch(`/stream/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streamId: data.streamId, forced: true, by: me }),
  }).catch(() => null);

  if (!res || !res.ok) {
    return Response.json({ error: "Couldn't end the session" }, { status: 502 });
  }
  await appendModLog({ action: "stream_force_offline", target: "site", by: me, reason: `session ${data.streamId}` });
  return Response.json({ live: false, ended: true, streamId: data.streamId });
}
