// A new report tells the streamer: one quiet push through stream-api's operator relay
// (POST /ops/notify — one push per key per 15 minutes, the suppressed count on the next). The push
// names no one and carries no reason: the alert topics are not private. The Mod Panel's Reports
// shows the rest. Best-effort: a failed push never fails the report.

import { streamApiFetch } from "./streamApi.ts";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function notifyNewReport(fetch: Fetch = streamApiFetch): Promise<void> {
  try {
    await fetch("/ops/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "web.report.new", title: "New report", message: "1 new report — Mod Panel › Reports" }),
    });
  } catch {
    // best-effort: the report is already saved
  }
}
