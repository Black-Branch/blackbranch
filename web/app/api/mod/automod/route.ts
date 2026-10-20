import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { AUTOMOD_QUEUE_SQL } from "@/app/lib/automodQueueSql";
import { instanceBool } from "@/app/lib/instanceConfigServer";

// GET — actionable held rows from EVERY producer (Twitch AutoMod holds plus
// our own blocklist / account_age / link_gate rows), for both mod surfaces:
// the mod panel section AND the inline chat bar, via useAutomodQueue's shared
// ~5s poll (mod-only data stays off the public WS bus).
// Twitch expires unresolved holds after ~5 minutes; normally the
// automod.message.update event flips the row, but if the EventSub socket
// missed it, sweep anything past the window before reading.
export async function GET() {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  await pool.query(
    // Twitch holds only. Twitch drops an unresolved hold after ~5 minutes, so
    // the row is genuinely dead. A BLOCKLIST hold has no such deadline — it is
    // our own queue, and sweeping it would silently discard exactly the
    // reviews it exists for.
    `UPDATE site.automod_held SET status = 'expired', resolved_at = now()
     WHERE status = 'pending' AND source = 'twitch'
       AND held_at < now() - interval '6 minutes'`
  ).catch(() => {});

  const { rows } = await pool.query<{
    id: number; twitch_msg_id: string | null; user_login: string | null;
    user_name: string | null; text: string; category: string | null;
    level: number | null; held_at: string; source: string; status: string;
    matched_term: string | null; matrix_id: string | null;
    user_id: string | null; platform: string | null; site_msg_id: number | null; confidence: string | null;
  }>(
    // 'blocked' rows are included: the message was never delivered, but a mod
    // still needs to see WHO said it — that is the whole point of recording it.
    // + automod's FLAGGED rows (platform messages it judged risky, already public): a mod
    // dismisses them. The link gate's flag-mode rows stay out — they are measurements.
    // FAIR: at most 5 rows per sender, newest first, then the newest 50 overall — so one person
    // flooding the queue cannot push everyone else's held messages out of sight.
    AUTOMOD_QUEUE_SQL
  );

  return Response.json({
    held: rows.map((r) => ({
      id: Number(r.id),
      msgId: r.twitch_msg_id,
      userLogin: r.user_login,
      userName: r.user_name,
      text: r.text,
      category: r.category,
      level: r.level,
      heldAt: r.held_at,
      source: r.source,
      status: r.status,
      matchedTerm: r.matched_term,
      matrixId: r.matrix_id,
      userId: r.user_id,
      platform: r.platform,
      siteMsgId: r.site_msg_id == null ? null : Number(r.site_msg_id),
      confidence: r.confidence == null ? null : Number(r.confidence),
    })),
    automod: await automodStatus(),
    // The AI automod switch, for the Mod Panel's on/off.
    aiEnabled: instanceBool("automod.enabled"),
  });
}

/** Automod's own state for the queue header ("degraded since hh:mm"); null when stream-api is
 *  unreachable or automod is off. */
async function automodStatus(): Promise<{ degraded: boolean; degradedSince: string | null; holdExpiry: number | null } | null> {
  try {
    const res = await streamApiFetch("/automod/status", { cache: "no-store" }, 2_000);
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as { enabled?: unknown; degraded?: unknown; degradedSince?: unknown; holdExpiry?: unknown } | null;
    if (!j || j.enabled !== true) return null;
    return {
      degraded: j.degraded === true, degradedSince: typeof j.degradedSince === "string" ? j.degradedSince : null,
      holdExpiry: Number.isInteger(j.holdExpiry) ? (j.holdExpiry as number) : null,
    };
  } catch { return null; }
}
