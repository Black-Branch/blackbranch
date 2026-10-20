import { streamApiFetch } from "@/app/lib/streamApi";
import { requireUser } from "@/app/lib/authGuard";
import { NextRequest } from "next/server";

// User timezone, captured silently from the browser (Intl.DateTimeFormat tz) and
// held on the CANONICAL identity (stream.users) so it survives identity merges and
// is available to the bot for accurate "their local time" awareness. Write-only
// from the client's perspective; NULL = unknown (the bot infers from activity).

// Light sanity check; stream-api validates against Intl authoritatively.
function plausibleTz(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length > 0 && tz.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(tz);
}

export async function PATCH(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const timezone = body?.timezone;
  if (!plausibleTz(timezone)) return new Response("Bad Request", { status: 400 });

  const res = await streamApiFetch("/identity/timezone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matrixId: matrixId, timezone }),
  });

  // The canonical identity may not be resolvable yet on a fresh session: this
  // silent capture can fire before /api/me/profile/reconcile has linked the
  // matrixId, so stream-api answers 404 "no canonical identity". Timezone is
  // write-only + best-effort, so treat that as a soft no-op (the browser will
  // re-send on the next load once reconcile has run) rather than a hard error.
  if (res.status === 404) return Response.json({ ok: false, pending: true });

  // Forward the real class of failure instead of laundering everything into a
  // 502: a 4xx (e.g. stream-api's authoritative Intl reject) is the request's
  // fault, not a gateway error — only a genuine upstream 5xx is a 502.
  if (!res.ok) {
    const status = res.status >= 400 && res.status < 500 ? res.status : 502;
    return new Response("Failed to record timezone", { status });
  }
  return Response.json({ ok: true });
}
