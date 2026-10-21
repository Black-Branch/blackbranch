import pool from "@/lib/db";
import { auth } from "@/auth";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { streamApiFetch } from "@/app/lib/streamApi";
import { setSlowModeOnTwitch } from "@/app/lib/platformMod/twitch";
import { twitchBroadcasterId } from "@/app/lib/twitch";
import { slowModeMirrors } from "@/app/lib/slowModeCopy";
import { NextRequest } from "next/server";

// GET — public read of the current slow-mode setting, plus whether the CALLER
// is exempt (mods/admins bypass enforcement; ChatInput uses this to skip the
// countdown UI for them). Anonymous callers get exempt: false.
export async function GET() {
  const { rows } = await pool.query<{ slow_mode_seconds: number }>(
    `SELECT slow_mode_seconds FROM site.chat_settings WHERE id = 1`
  );
  const slowModeSeconds = rows[0]?.slow_mode_seconds ?? 0;

  let exempt = false;
  const session = await auth().catch(() => null);
  if (session?.user?.id) {
    const { rows: u } = await pool
      .query<{ is_mod: boolean; is_admin: boolean }>(
        `SELECT is_mod, is_admin FROM site.users WHERE matrix_id = $1`,
        [session.user.id]
      )
      .catch(() => ({ rows: [] as { is_mod: boolean; is_admin: boolean }[] }));
    exempt = !!(u[0]?.is_mod || u[0]?.is_admin);
  }

  // Per-user limits (migrate-v78) are mod-only information — a viewer must not be
  // able to enumerate who is rate-limited.
  let userLimits: { matrixId: string; seconds: number; expiresAt: string | null }[] | undefined;
  if (exempt) {
    const { rows: u } = await pool.query<{ matrix_id: string; seconds: number; expires_at: Date | null }>(
      `SELECT matrix_id, seconds, expires_at FROM site.user_slow_mode
        WHERE expires_at IS NULL OR expires_at > NOW()
        ORDER BY updated_at DESC`
    ).catch(() => ({ rows: [] as { matrix_id: string; seconds: number; expires_at: Date | null }[] }));
    userLimits = u.map((r) => ({
      matrixId: r.matrix_id,
      seconds: r.seconds,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));
  }

  return Response.json({
    slowModeSeconds, exempt, ...(userLimits ? { userLimits } : {}),
    // Where the setting is copied, so the controls never promise a platform this install lacks.
    mirrorsTo: slowModeMirrors({ twitchBroadcasterId: twitchBroadcasterId() }),
  });
}

// POST { seconds } — mod-gated. Persists the singleton, mirrors to Twitch
// (best-effort, clamped 3–120s there), and tells stream-api to broadcast the
// {type:'chat_settings'} frame so every open client updates live.
export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);

  // ── Per-user slow mode (migrate-v78) ─────────────────────────────────────
  // Same command, same concept, so it lives on the same route rather than a
  // parallel one. `targetId` present = per-user; absent = the global setting.
  const targetId = typeof body?.targetId === "string" ? body.targetId.trim() : "";
  if (targetId) {
    // Privilege ceiling: a mod never slows an admin or another mod.
    const denied = await assertCanModerate(mod, targetId);
    if (denied) return denied;
    const secs = Number(body?.seconds);
    if (!Number.isFinite(secs) || secs < 0) return new Response("Bad Request", { status: 400 });
    const seconds = Math.min(Math.round(secs), 3600);

    if (seconds === 0) {
      await pool.query(`DELETE FROM site.user_slow_mode WHERE matrix_id = $1`, [targetId]);
      await appendModLog({ action: "slowmode_user", target: targetId, by: mod, reason: "off" });
      return Response.json({ ok: true, targetId, seconds: 0 });
    }

    // NULL expiry = indefinite, which stays possible but must be asked for.
    const mins = Number(body?.expiresInMinutes);
    const expiresAt = Number.isFinite(mins) && mins > 0
      ? new Date(Date.now() + mins * 60_000).toISOString()
      : null;

    await pool.query(
      `INSERT INTO site.user_slow_mode (matrix_id, seconds, expires_at, set_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (matrix_id) DO UPDATE
         SET seconds = EXCLUDED.seconds, expires_at = EXCLUDED.expires_at,
             set_by = EXCLUDED.set_by, updated_at = NOW()`,
      [targetId, seconds, expiresAt, mod]
    );
    await appendModLog({
      action: "slowmode_user", target: targetId, by: mod,
      reason: `${seconds}s${expiresAt ? ` until ${expiresAt}` : ""}`,
    });
    // No Twitch mirror: this is a site-account limit and Twitch has no per-user
    // slow mode to mirror it onto.
    return Response.json({ ok: true, targetId, seconds, expiresAt });
  }

  const raw = Number(body?.seconds);
  if (!Number.isFinite(raw) || raw < 0) return new Response("Bad Request", { status: 400 });
  const seconds = Math.min(Math.round(raw), 3600);

  await pool.query(
    `UPDATE site.chat_settings
     SET slow_mode_seconds = $1, updated_by = $2, updated_at = now()
     WHERE id = 1`,
    [seconds, mod]
  );

  await appendModLog({ action: "slowmode", target: "chat", by: mod, reason: seconds > 0 ? `${seconds}s` : "off" });

  // Twitch mirror + live broadcast are both best-effort: the site setting is
  // already persisted and enforced by /api/chat/send either way.
  void setSlowModeOnTwitch(mod, seconds);
  await streamApiFetch(`/chat/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slowModeSeconds: seconds }),
  }).catch(() => {});

  return Response.json({ ok: true, slowModeSeconds: seconds });
}
