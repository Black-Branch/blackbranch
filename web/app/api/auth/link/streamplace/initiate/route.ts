// Begin stream.place (AT Protocol) account linking. Unlike the OAuth2 platforms,
// ATProto OAuth starts from the user's handle (to discover their PDS/auth server).
import { NextRequest } from "next/server";
import { requireUser } from "@/app/lib/authGuard";
import { getAtprotoClient } from "@/app/lib/atprotoClient";
import { isValidHandle, normalizeHandle } from "@/app/lib/atprotoHandle";

export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => ({}));
  const handle = typeof body.handle === "string" ? normalizeHandle(body.handle) : "";
  if (!handle) return Response.json({ error: "handle_required" }, { status: 400 });
  // Validate BEFORE the resolver sees it. client.authorize() resolves
  // the handle over DNS and by fetching https://<handle>/.well-known/atproto-did,
  // both inside the library and both outside safeFetch. We can't route the
  // library's DNS through our guard, so the boundary we hold is the input:
  // anything that isn't syntactically a public domain never reaches the resolver.
  if (!isValidHandle(handle)) return Response.json({ error: "invalid_handle" }, { status: 400 });

  try {
    const client = await getAtprotoClient();
    // state is echoed back on callback; carry who initiated + the typed handle.
    const state = JSON.stringify({ matrixId, handle });
    const url = await client.authorize(handle, { state });
    return Response.json({ authorizationUrl: url.toString() });
  } catch (e) {
    // Log the detail, never return it. Echoing the resolver's error
    // turns this route into an SSRF oracle: the distinction between "ECONNREFUSED",
    // "ENOTFOUND" and a TLS error tells an unauthenticated-in-effect caller which
    // internal hosts and ports exist. The caller only needs to know it failed.
    console.error("[link:streamplace:initiate]", e);
    return Response.json({ error: "authorize_failed" }, { status: 400 });
  }
}
