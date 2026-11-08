import { getMatrixSession, endedSessionResponse } from "@/app/lib/matrixSession";
import { readPresenceStatus } from "@/app/lib/presenceServer";

// Returns a fresh Matrix access token for THIS browser session's device.
// All token/refresh logic lives in matrixSession.ts (per-session rows —
// concurrent browsers never receive each other's device identity).
export async function GET() {
  try {
    const mx = await getMatrixSession();
    if (!mx) return Response.json({ error: "unauthenticated" }, { status: 401 });
    return Response.json({
      accessToken: mx.accessToken,
      expiresAt: mx.expiresAt,
      homeserver: mx.homeserver,
      deviceId: mx.deviceId,
      presenceStatus: (await readPresenceStatus(mx.matrixId)).status,
    });
  } catch (e) {
    // Ended: "revoked" (confirmed — the browser wipes this device's store) or "signed_out" (the
    // browser signs out and keeps its store and device id). matrixSessionCore.ts classifies.
    const ended = endedSessionResponse(e);
    if (ended) return ended;
    console.error("[matrix/token]", e);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
