import { destroyMatrixSession } from "@/app/lib/matrixSession";

// Ends THIS browser session's Matrix session: revokes the token chain at the
// homeserver (under MAS this also deletes the Synapse device) and removes the
// site.user_sessions row. The Auth.js cookie is cleared by signOut() client-side.
export async function POST() {
  await destroyMatrixSession().catch((e) => {
    console.error("[matrix/logout]", e);
  });
  return Response.json({ ok: true });
}
