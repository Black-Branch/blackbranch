import { requireMod } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";

// Mod proxy for the support bar — the `/bar reset` site command.
//
// `reset` zeroes the support bar AND the marathon timer and clears overlays:
// stream-api's /support-bar/reset calls supportBar.reset() and timer.reset()
// together. It is the "starting a fresh stream" button, not a bar-only tweak, so
// the command description says so and the client asks nothing further.
export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  if (String((body as { action?: string } | null)?.action ?? "") !== "reset") {
    return new Response("Usage: /bar reset", { status: 400 });
  }

  const res = await streamApiFetch("/support-bar/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // A 400 is stream-api telling the CALLER why — "a night is running — end
    // it before resetting" (a reset mid-night would hand out unsold frontier
    // and freeze the clock). Passed through with the sentence so the panel can
    // show it; anything else is a real upstream failure.
    if (res.status === 400) {
      let msg = t || "Reset refused";
      try {
        const parsed = JSON.parse(t) as { error?: unknown };
        if (typeof parsed?.error === "string" && parsed.error) msg = parsed.error;
      } catch { /* not JSON — use the text */ }
      return Response.json({ error: msg }, { status: 400 });
    }
    return new Response(t || "Reset failed", { status: 502 });
  }
  return Response.json({ ok: true });
}
