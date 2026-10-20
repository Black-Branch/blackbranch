// web/app/api/billing/result/route.ts
import { latestFailedResult } from "@/app/lib/paymentResultServer";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// A 3s poll for 5 minutes is 100 requests; 200 leaves headroom for a
// double-mount. No auth: a cs_... id is unguessable, response carries no
// amount or identity, only decline copy.
const isResultLimited = createSlidingWindowLimiter(5 * 60_000, 200);
// Five checkout boxes polling for five minutes behind one NAT is 500; the
// per-session key above is chosen by the caller and bounds nothing on its own.
const isResultIpLimited = createSlidingWindowLimiter(5 * 60_000, 1000);

// GET /api/billing/result?session=cs_...&since=<ISO timestamp>
export async function GET(req: NextRequest) {
  if (isResultIpLimited(ipKey(req))) return new Response("Too many requests", { status: 429 });
  const session = req.nextUrl.searchParams.get("session");
  if (!session) return new Response("Bad Request", { status: 400 });
  if (isResultLimited(`session:${session}`)) return new Response("Too many requests", { status: 429 });
  const sinceParam = req.nextUrl.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : new Date(0);
  // An unparsable since would otherwise reach pg as an Invalid Date and 500.
  if (Number.isNaN(since.getTime())) return new Response("Bad Request", { status: 400 });
  const result = await latestFailedResult(session, since);
  if (!result) return Response.json({ outcome: "none" });
  return Response.json({ outcome: "failed", ...result });
}
