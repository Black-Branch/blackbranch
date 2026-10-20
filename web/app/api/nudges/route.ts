import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { linkNudgeState } from "@/app/lib/nudges";

// Per-user nudge state — currently one nudge, `link_account`.
//
// The SERVER decides whether a nudge shows, because every input is
// server-side: linked-account count, dismissal history, the 48 h clock. The
// client just renders what GET says and reports dismissals. That is what makes
// the reminder follow the USER instead of the device.
//
// Timing rules:
//   • shows while the user has zero cross-postable linked accounts
//   • a dismissal hides it for 48 h
//   • from the second showing on, the client may offer "never again"
//   • never latches — see the upsert.

const KINDS = new Set(["link_account"]);

export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const [{ rows: linkRows }, { rows: nudgeRows }] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM site.accounts
       WHERE matrix_id = $1 AND type IN ('oauth','atproto')`,
      [matrixId]
    ),
    pool.query<{ dismissed_at: Date; count: number; never: boolean }>(
      `SELECT dismissed_at, count, never FROM site.user_nudges
       WHERE matrix_id = $1 AND kind = 'link_account'`,
      [matrixId]
    ),
  ]);

  const linked = Number(linkRows[0]?.n ?? 0) > 0;
  return Response.json({
    link_account: linkNudgeState(linked, nudgeRows[0], Date.now()),
  });
}

export async function POST(req: Request) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = (await req.json().catch(() => ({}))) as { kind?: unknown; never?: unknown };
  const kind = String(body.kind ?? "");
  if (!KINDS.has(kind)) return Response.json({ error: "unknown_kind" }, { status: 400 });
  const never = body.never === true;

  // `never` ORs with what's stored: once a user says "don't ask again", a
  // later plain dismiss (or a second device racing) must not quietly re-arm
  // the nag. count grows per dismissal — it is what turns on offerNever.
  await pool.query(
    `INSERT INTO site.user_nudges (matrix_id, kind, dismissed_at, count, never)
     VALUES ($1, $2, now(), 1, $3)
     ON CONFLICT (matrix_id, kind) DO UPDATE
       SET dismissed_at = now(),
           count = site.user_nudges.count + 1,
           never = site.user_nudges.never OR EXCLUDED.never`,
    [matrixId, kind, never]
  );
  return Response.json({ ok: true });
}
