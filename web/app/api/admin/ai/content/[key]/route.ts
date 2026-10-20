import { type NextRequest } from "next/server";
import { requireAdminMutation, writeContent } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT    /api/admin/ai/content/<key>  { body }  — save a prompt, the help desk's facts, or the
//                                                 bot's behavior file (stream-api validates)
// DELETE /api/admin/ai/content/<key>            — revert to the shipped default
// ADMIN ONLY and SAME-ORIGIN ONLY, checked here. `updatedBy` is the admin's own Matrix id from
// the session, never from the body.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { key } = await params;
  const b = (await req.json().catch(() => null)) as { body?: unknown } | null;
  if (!b || typeof b.body !== "string") return Response.json({ error: "body (text) is required" }, { status: 400 });
  const r = await writeContent(decodeURIComponent(key), b.body, admin);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { key } = await params;
  const r = await writeContent(decodeURIComponent(key), null, admin);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
