import { NextRequest } from "next/server";
import { getMatrixSession, RevokedSessionError } from "@/app/lib/matrixSession";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
// homeserverFetch, never a raw fetch: `mx.homeserver` is per-user stored state, so for an
// outside account it is a user-influenced URL carrying a Bearer token and goes through the
// SSRF-pinned safeFetch. This install's own homeserver is trusted and may sit on a private address.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  try {
    const mx = await getMatrixSession();
    if (!mx) return Response.json({ error: "unauthorized" }, { status: 401 });

    const res = await homeserverFetch(`${mx.homeserver}/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${mx.accessToken}` },
    }).catch(() => null);

    if (!res) return Response.json({ error: "homeserver_unreachable" }, { status: 502 });
    // Only the status is used; release the connection (the request itself has homeserverFetch's
    // default deadline).
    void res.body?.cancel().catch(() => {});

    // 401 means the homeserver requires interactive auth to remove this device
    if (res.status === 401) {
      return Response.json({ error: "requires_reauth" }, { status: 401 });
    }

    if (!res.ok) {
      return Response.json({ error: "delete_failed", status: res.status }, { status: 502 });
    }

    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof RevokedSessionError) {
      return Response.json({ error: "session_expired", reason: "revoked" }, { status: 401 });
    }
    console.error("[matrix/devices delete]", e);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
