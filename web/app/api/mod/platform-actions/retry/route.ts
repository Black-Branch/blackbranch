import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { banOnTwitch, unbanOnTwitch, setSlowModeOnTwitch } from "@/app/lib/platformMod/twitch";
import { banOnKick, unbanOnKick } from "@/app/lib/platformMod/kick";
import { banOnYouTube, unbanOnYouTube } from "@/app/lib/platformMod/youtube";
import { NextRequest } from "next/server";

// POST { id } — re-run a failed platform fan-out from the mod panel's
// propagation view or the status line after an action (e.g. the target had no
// linked Kick id yet, YouTube wasn't live, a token hiccuped). The retry acts as the
// CURRENT mod and records a NEW audit row in the SAME batch — the original row stays
// as history, and the batch's newest row per platform is the answer the status line shows. Only state-shaped actions are retryable: a stale single-message
// delete or purge batch isn't meaningfully re-runnable from a row id.
// A retry is a new action by the current mod, so it passes the same privilege
// ceiling as the original: a mod cannot re-run a row against the owner (403),
// and a target the ceiling cannot decide on is refused (503).
export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad Request", { status: 400 });

  const { rows } = await pool.query<{
    action: string; platform: string; target_id: string | null; duration_seconds: number | null; batch_id: string | null;
  }>(
    `SELECT action, platform, target_id, duration_seconds, batch_id
     FROM site.platform_mod_actions WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return new Response("Not Found", { status: 404 });

  const platform = row.platform.toLowerCase();

  if (row.action === "slowmode" && platform === "twitch") {
    const { rows: s } = await pool.query<{ slow_mode_seconds: number }>(
      `SELECT slow_mode_seconds FROM site.chat_settings WHERE id = 1`
    );
    await setSlowModeOnTwitch(mod, s[0]?.slow_mode_seconds ?? 0);
    return Response.json({ ok: true });
  }

  if (!row.target_id) return Response.json({ error: "unsupported_retry" }, { status: 422 });

  const denied = await assertCanModerate(mod, row.target_id);
  if (denied) return denied;

  if (row.action === "ban" || row.action === "timeout") {
    const dur = row.action === "timeout" ? row.duration_seconds : null;
    if (platform === "twitch") await banOnTwitch(mod, row.target_id, dur, null, row.batch_id);
    else if (platform === "kick") await banOnKick(mod, row.target_id, dur, null, row.batch_id);
    else if (platform === "youtube") await banOnYouTube(mod, row.target_id, dur, row.batch_id);
    else return Response.json({ error: "unsupported_retry" }, { status: 422 });
    return Response.json({ ok: true });
  }

  if (row.action === "unban") {
    if (platform === "twitch") await unbanOnTwitch(mod, row.target_id, row.batch_id);
    else if (platform === "kick") await unbanOnKick(mod, row.target_id, row.batch_id);
    else if (platform === "youtube") await unbanOnYouTube(mod, row.target_id, row.batch_id);
    else return Response.json({ error: "unsupported_retry" }, { status: 422 });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "unsupported_retry" }, { status: 422 });
}
