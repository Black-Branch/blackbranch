import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { banHistoryCheck, banHistoryResponse } from "@/app/lib/banHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?targetId= — the ceiling alone, asked BEFORE the moderator's client redacts anything.
// POST {targetId, window, communityRedacted, communityFailed, siteRemoved, batchId} — after a ban's
// "Delete message history" ran in the moderator's client: ONE `history_deleted` mod-log row.
// Handlers: app/lib/banHistory.ts.
export async function GET(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  return banHistoryCheck(req, {
    mod,
    ceiling: (actor, target) => assertCanModerate(actor, target),
  });
}

export async function POST(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  return banHistoryResponse(req, {
    mod,
    ceiling: (actor, target) => assertCanModerate(actor, target),
    log: (e) => appendModLog(e),
  });
}
