// The Stream tab's server side: liveness and the shared request parsing for its four admin-only
// routes. Liveness asks stream-api first — its heartbeat rule is the rig's own truth — and falls
// back to the database when it cannot be asked. Never blocks a render for long: a 1.5 s deadline.
import pool from "@/lib/db";
import { streamApiFetch } from "./streamApi";
import { int, type StreamLive } from "./streamStats";
import { liveFromDatabase, type Query } from "./streamStatsSql";

/** The pool as the loaders' query function. */
export const query: Query = (sql, params) => pool.query(sql, params as unknown[]);

type Current = { live?: boolean; streamId?: unknown; startedAt?: unknown; ytVideoId?: unknown; viewers?: Record<string, unknown> | null };

/** Live or not, plus the confirmed YouTube broadcast id (for the title read). */
export async function streamLiveNow(): Promise<{ live: StreamLive; ytVideoId: string | null }> {
  try {
    const res = await streamApiFetch("/stream/current", { cache: "no-store" }, 1500);
    if (!res.ok) throw new Error(`stream-api ${res.status}`);
    const j = (await res.json()) as Current;
    if (j.live !== true) return { live: { live: false }, ytVideoId: null };
    const startedMs = Date.parse(String(j.startedAt ?? ""));
    if (typeof j.streamId !== "string" || Number.isNaN(startedMs)) throw new Error("stream-api shape");
    const v = j.viewers;
    const n = (x: unknown) => (x === null || x === undefined ? null : int(x, "viewers"));
    return {
      live: {
        live: true, viaSnapshot: false, streamId: j.streamId, startedMs,
        viewers: v ? { twitch: n(v.twitch), youtube: n(v.youtube), kick: n(v.kick), streamplace: n(v.streamplace), total: int(v.total ?? 0, "total") } : null,
      },
      ytVideoId: typeof j.ytVideoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(j.ytVideoId) ? j.ytVideoId : null,
    };
  } catch {
    return { live: await liveFromDatabase(query), ytVideoId: null };
  }
}

/** `income=1` opts money in; anything else leaves it out of the answer entirely. */
export function wantsIncome(url: URL): boolean {
  return url.searchParams.get("income") === "1";
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
