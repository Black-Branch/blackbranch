import { type NextRequest } from "next/server";
import { requireAdminMutation, writeInstanceValue, clearInstanceValue, refindDerivedIds } from "@/app/lib/instanceAdminServer";
import { reloadInstanceConfig } from "@/app/lib/instanceConfigServer";
import { requestRenderFor } from "@/app/lib/hostRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT    /api/admin/instance/<key>  { value }  — store a value (a credential is encrypted by
//                                                stream-api, the one writer)
// DELETE /api/admin/instance/<key>             — back to the default (env still wins)
// ADMIN ONLY and SAME-ORIGIN ONLY, checked here. The answer is status, never the value.
// `updated_by` is the admin's own Matrix id — taken from the session, never from the body.
// A setting the host renders (federation, sign-up) also asks the bundle's host to re-render, so it
// applies without a trip to the server (hostRequests.ts). A channel's save also finds the platform
// id behind it (derivedIds.ts) and answers what it found in `found`.

export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const name = decodeURIComponent((await params).key);
  const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
  if (!body || !("value" in body)) return Response.json({ error: "value is required" }, { status: 400 });
  const r = await writeInstanceValue(name, body.value, admin);
  if (r.status !== 200) return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  await reloadInstanceConfig();
  await requestRenderFor(name);
  // A channel (or the app keys that let the site ask) changed: the platform id behind it is found
  // again and saved, so the panel never asks anyone to type a numeric id.
  const found = await refindDerivedIds(name, admin);
  if (found.some((f) => f.ok)) await reloadInstanceConfig();
  const out = found.length && r.body && typeof r.body === "object" ? { ...(r.body as object), found } : r.body;
  return Response.json(out, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const name = decodeURIComponent((await params).key);
  const r = await clearInstanceValue(name, admin);
  if (r.status === 200) { await reloadInstanceConfig(); await requestRenderFor(name); }
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
