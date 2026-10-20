export const dynamic = "force-dynamic";

import { type NextRequest } from "next/server";
import { getStreamStatus } from "@/app/lib/streamStatus";
import { recordAndMaybeFlush } from "@/app/lib/sourceCensusStore";

// The per-source viewer census rides this route because every open tab already
// polls it every 30s — no new timer, no new request. Policy is in
// app/lib/sourceCensus.ts; the singleton is in app/lib/sourceCensusStore.ts.
//
// The status answer is resolved FIRST and returned WITHOUT WAITING on the
// census at all — the call below is fire-and-forget, not awaited. A
// `try/catch` around an `await` cannot save this route from a hang: a pool
// query that never settles leaves that `await` pending forever no matter
// what surrounds it, and this endpoint is how the whole site learns whether
// the streamer is live, so it must never be the one held hostage. Fire-and-forget is
// safe here specifically because web runs as a long-lived standalone Node
// server (`.next/standalone/server.js`), not a serverless
// function that could be torn down mid-request — the process keeps running
// long enough for the promise to settle on its own, whichever way it goes.
export async function GET(req: NextRequest) {
  const status = await getStreamStatus();
  recordAndMaybeFlush(new URL(req.url).searchParams).catch((err) => {
    console.warn("[census] sample or flush failed:", err);
  });
  return Response.json(status);
}
