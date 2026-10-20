import { getMatrixSession, RevokedSessionError } from "@/app/lib/matrixSession";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { readJsonCapped } from "@/app/lib/boundedBody";
// homeserverFetch, never a raw fetch: `mx.homeserver` is per-user stored state, so for an
// outside account it is a user-influenced URL carrying a Bearer token and goes through the
// SSRF-pinned safeFetch. This install's own homeserver is trusted and may sit on a private address.

export async function GET() {
  try {
    const mx = await getMatrixSession();
    if (!mx) return Response.json({ error: "unauthorized" }, { status: 401 });

    const res = await homeserverFetch(`${mx.homeserver}/_matrix/client/v3/devices`, {
      headers: { Authorization: `Bearer ${mx.accessToken}` },
    }).catch(() => null);

    if (!res?.ok) return Response.json({ error: "homeserver_error" }, { status: 502 });

    // ~200 bytes a device; 256 KiB is over a thousand sessions, far past any real account. The
    // deadline over this read is homeserverFetch's default.
    const data = (await readJsonCapped(res, 256 * 1024)) as { devices?: unknown } | null;
    if (!data) return Response.json({ error: "homeserver_error" }, { status: 502 });
    return Response.json({ devices: data.devices ?? [], accountUrl: mx.accountUrl, homeserver: mx.homeserver });
  } catch (e) {
    if (e instanceof RevokedSessionError) {
      return Response.json({ error: "session_expired", reason: "revoked" }, { status: 401 });
    }
    console.error("[matrix/devices]", e);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
