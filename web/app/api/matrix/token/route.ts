import { getMatrixSession, RevokedSessionError } from "@/app/lib/matrixSession";
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
    if (e instanceof RevokedSessionError) {
      // Session revoked (MAS account page, admin, expiry) — client must wipe
      // local crypto state and sign out fully.
      return Response.json({ error: "session_expired", reason: "revoked" }, { status: 401 });
    }
    console.error("[matrix/token]", e);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
