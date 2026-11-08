// The server's side of a purge (modPurge.ts runPurge): the pool, stream-api's purge frame, the mod
// log and the platform fan-out. One wiring for the Purge button's route and the ban route.
import pool from "@/lib/db";
import { appendModLog } from "@/app/lib/modlog";
import { streamApiFetch } from "@/app/lib/streamApi";
import { fanOutPurge } from "@/app/lib/platformMod";
import { copiesForMessages } from "@/app/lib/platformCopies";
import type { PurgeDeps } from "@/app/lib/modPurge";

export function purgeDeps(mod: string, targetId: string): PurgeDeps {
  return {
    query: (sql, params) => pool.query(sql, params),
    broadcast: (items, batchId) => streamApiFetch(`/chat/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, batchId }),
    }).catch(() => {}),
    copies: copiesForMessages,
    log: (reason, batchId) => appendModLog({ action: "purge", target: targetId, by: mod, batchId, reason }),
    fanOut: (kickIds, youtubeIds, batchId, opts) => fanOutPurge(mod, targetId, kickIds, youtubeIds, batchId, opts),
  };
}
