import pool from "@/lib/db";
import { auth } from "@/auth";
import { createCooldown, createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { dmNudges } from "@/app/lib/dm/nudgeBox";
import { NextRequest } from "next/server";
import { ACTIVE_BAN_SQL, DM_BANNED } from "@/app/lib/dm/banGate";

// The DM nudge: "someone just sent you a direct message", for the recipient's own page only.
// The nudge stays on this server (nudgeBox.ts) and the recipient's signed-in page asks for it —
// nothing about it goes out on the public chat socket, so no one can learn a recipient's nudges by
// sending one (external review S5). A nudge carries no sender, room or content: a forged one only
// makes a page look and find nothing.
//   GET  → { at } — the newest pending nudge stamp for this session's own account (0 = none).
//   POST { to } → nudge `to` (a site account). 20 a minute per sender, one per 3 s per pair.

const perSender = createSlidingWindowLimiter(60_000, 20);
const perPair = createCooldown(3_000);

export async function GET() {
  const session = await auth().catch(() => null);
  const me = session?.user?.id;
  if (!me) return Response.json({ error: "Sign in first." }, { status: 401 });
  return Response.json({ at: dmNudges.latest(me) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const session = await auth().catch(() => null);
  const me = session?.user?.id;
  if (!me) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { rows: ban } = await pool.query(ACTIVE_BAN_SQL, [me]).catch(() => ({ rows: [] as unknown[] }));
  if (ban.length) return Response.json({ error: DM_BANNED }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { to?: unknown } | null;
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!/^@[^:\s]+:\S+$/.test(to) || to === me) return Response.json({ error: "to required" }, { status: 400 });
  if (perSender(me) || perPair.hit(`${me}>${to}`)) return Response.json({ error: "slow down" }, { status: 429 });

  const { rows } = await pool.query(
    `SELECT 1 FROM site.users WHERE matrix_id = $1 AND deleted_at IS NULL`, [to],
  ).catch(() => ({ rows: [] as unknown[] }));
  if (!rows.length) return Response.json({ error: "no such account" }, { status: 404 });

  dmNudges.record(to);
  return Response.json({ ok: true });
}
