import { randomUUID } from "node:crypto";
import pool from "@/lib/db";
import { requireMod, assertCanModerateAccount } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { fanOutBan, fanOutUnban } from "@/app/lib/platformMod";
import { chatBanBody, pushChatBan } from "@/app/lib/chatBanPush";
import { timeoutPostResponse, timeoutDeleteResponse, type TimeoutDeps } from "@/app/lib/community/modTimeout";
import { requestReconcile } from "@/app/lib/community/reconcileRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST {userId, minutes, reason} — a mod times someone out (the member card's Timeout); DELETE
// {userId} lifts it. Handlers: app/lib/community/modTimeout.ts. Each verb names its ceiling and its
// platform call itself (modCeilingRoutes.test.ts reads them in the verb's body).
function shared(mod: string): Omit<TimeoutDeps, "ceiling" | "fanOut" | "fanOutLift"> {
  return {
    db: pool,
    mod,
    log: (e) => appendModLog(e),
    pushChat: (b) => pushChatBan(chatBanBody({ matrixIds: [b.matrixId], canonicalId: null, expiresAt: b.expiresAt, lift: b.lift })),
    reconcile: () => requestReconcile(),
    batchId: randomUUID,
  };
}

const none = () => [];

export async function POST(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  return timeoutPostResponse(req, {
    ...shared(mod),
    ceiling: (actor, target) => assertCanModerateAccount(actor, target),
    fanOut: (target, minutes, reason, batchId) => fanOutBan(mod, target, minutes, reason, batchId),
    fanOutLift: none,
  });
}

export async function DELETE(req: Request) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  return timeoutDeleteResponse(req, {
    ...shared(mod),
    ceiling: (actor, target) => assertCanModerateAccount(actor, target),
    fanOut: none,
    fanOutLift: (target, batchId) => fanOutUnban(mod, target, batchId),
  });
}
