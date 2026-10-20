import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { modDeleteMessage } from "@/app/lib/modDelete";
import { appendModLog } from "@/app/lib/modlog";
import { streamApiFetch } from "@/app/lib/streamApi";
import { fanOutDelete } from "@/app/lib/platformMod";
import { deleteSiteMessageEverywhere } from "@/app/lib/siteMessageDelete";
import { NextRequest } from "next/server";
import { normalizePlatform } from "@/app/lib/nativePlatform";

// POST { platform, messageId } — a mod deletes one line. The id is normalised once and checked
// against the moderation ceiling (the line's author) before anything is written: modDelete.ts.
export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });
  // A page opened before the platform-key rename may still send the site's old id (nativePlatform.ts).
  const platform = normalizePlatform(body.platform);

  return modDeleteMessage(mod, platform, body.messageId, {
    query: (sql, params) => pool.query(sql, params),
    ceiling: (actor, target) => assertCanModerate(actor, target),
    deleteNative: deleteSiteMessageEverywhere,
    streamDelete: (messageId, p) => streamApiFetch(`/chat/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, platform: p }),
    }),
    log: (target) => appendModLog({ action: "delete", target, by: mod }),
    fanOut: (messageId, p) => fanOutDelete(mod, messageId, p),
  });
}
