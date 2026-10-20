import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { deletionCheck, deleteAccount } from "@/app/lib/accountDeletion";
import { sameOriginRequest } from "@/app/lib/instanceAdminView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/me/delete-account            — what the confirm screen needs: the account name to
//                                          type, whether this sign-in is fresh enough, whether a
//                                          subscription blocks it, who removes the Matrix account
// POST /api/me/delete-account { name }   — delete the signed-in account (accountDeletion.ts)
// Only ever the session's OWN account: there is no target parameter. The POST is same-origin
// only, and every precondition is checked again on the server.
async function me(): Promise<{ matrixId: string; sessionId: string | null } | Response> {
  const session = await auth().catch(() => null);
  const matrixId = session?.user?.id;
  if (!matrixId) return Response.json({ error: "sign in first" }, { status: 401 });
  return { matrixId, sessionId: (session as { sessionId?: string } | null)?.sessionId ?? null };
}

export async function GET() {
  const who = await me();
  if (who instanceof Response) return who;
  return Response.json(await deletionCheck(who.matrixId, who.sessionId), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req.headers)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  const who = await me();
  if (who instanceof Response) return who;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const r = await deleteAccount(who.matrixId, who.sessionId, body?.name);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ ok: true, matrix: r.matrix }, { headers: { "Cache-Control": "no-store" } });
}
