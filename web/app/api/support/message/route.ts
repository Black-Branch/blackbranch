import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { getChatIdentity } from "@/app/lib/chatIdentity";
import { getActiveTier } from "@/app/lib/entitlements";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { sanitizeChatMessage } from "@/app/lib/sanitize";
import { matchesBlacklist } from "@/app/lib/blacklist";
import { streamApiFetch } from "@/app/lib/streamApi";
import { transcriptRole } from "@/app/lib/support/validate";
import { NextRequest } from "next/server";
import { shutdownSignal } from "@/app/lib/shutdownSignal";

export const runtime = "nodejs";

// LLM turns are the only support path that costs money — a tighter window
// than the ticket/report writes, with the retry surfaced so the help desk can say it.
const WINDOW_MS = 300_000;
const LIMIT = 10;
const isLimited = createSlidingWindowLimiter(WINDOW_MS, LIMIT);

// POST /api/support/message { text, history? } → { text } | 429 | 503
// One free-text support turn: relayed to stream-api's held-request relay
// (/bot/support/ask), answered by the brain's long-poll loop. The relay
// holds up to 30 s; anything else here degrades to 503 and the panel offers
// a ticket instead.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  if (isLimited(`support-llm:${matrixId}`)) {
    // The window is sliding, so the honest "when" is unknown per-hit; the
    // ceiling is enough for the panel's cooldown line.
    return Response.json({ error: "throttled", retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { text?: unknown; history?: unknown } | null;
  const text = sanitizeChatMessage(typeof body?.text === "string" ? body.text.slice(0, 1000) : "");
  if (!text) return new Response("Bad Request", { status: 400 });
  if (matchesBlacklist(text)) return Response.json({ error: "blocked" }, { status: 422 });
  const history = Array.isArray(body?.history)
    ? body.history.slice(-8).flatMap((m) => {
        const t = m as { role?: unknown; text?: unknown } | null;
        const role = transcriptRole(t?.role);
        if (role === null || typeof t?.text !== "string") return [];
        return [{ role, text: t.text.slice(0, 500) }];
      })
    : [];

  // The asking user's account state rides WITH the question, so the help desk can
  // answer "am I a Supporter / did my link go through / what's my balance"
  // without any tool round-trip — and it reuses the ONE canonical entitlement
  // read (getActiveTier counts gifts; re-deriving it brain-side would fork
  // the Supporter definition, the exact bug the encrypt feature once had).
  const [identity, tier, linksRes, walletRes] = await Promise.all([
    getChatIdentity(matrixId),
    getActiveTier(matrixId).catch(() => null),
    pool.query<{ provider: string }>(
      `SELECT provider FROM site.accounts WHERE matrix_id = $1 AND type IN ('oauth','atproto')`,
      [matrixId]
    ).catch(() => ({ rows: [] as { provider: string }[] })),
    pool.query<{ balance: string }>(
      `SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`,
      [matrixId]
    ).catch(() => ({ rows: [] as { balance: string }[] })),
  ]);
  const account = {
    username: identity.username,
    supporter: tier === "supporter",
    linked: linksRes.rows.map((r) => r.provider),
    points: Number(walletRes.rows[0]?.balance ?? 0),
  };
  try {
    const res = await streamApiFetch("/bot/support/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matrixId, username: identity.username, text, history, account }),
      // The relay holds up to 30 s (its ask timeout answers 504); this is the
      // hard cap above it so a wedged socket can't pin the route forever. And it
      // ends at once when the process is told to stop (contract 5): a held ask
      // must not hold the shutdown past Docker's grace.
      signal: AbortSignal.any([AbortSignal.timeout(35_000), shutdownSignal()]),
    });
    if (!res.ok) return Response.json({ error: "unavailable" }, { status: 503 });
    const d = (await res.json().catch(() => null)) as { text?: string } | null;
    if (!d?.text) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ text: d.text });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
