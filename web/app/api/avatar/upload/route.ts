import pool from "@/lib/db";
import { setMatrixAvatarUrl } from "@/app/lib/matrixProfile";
import { createCooldown } from "@/app/lib/rateLimit";
import { uploadImageToMatrixMedia } from "@/app/lib/matrixMediaUpload";
import { NextRequest } from "next/server";

// One upload per 60s per user, armed at check time (a failed upload still
// spends the slot — uploads are expensive regardless of outcome).
const uploadCooldown = createCooldown(60_000);

export async function POST(req: NextRequest) {
  // Shared pipeline (matrixMediaUpload.ts): session, cooldown, size caps,
  // magic-byte validation, Matrix media upload, mxc:// guard.
  const up = await uploadImageToMatrixMedia(req, {
    field: "avatar",
    maxBytes: 4 * 1024 * 1024,
    cooldown: uploadCooldown,
  });
  if (!up.ok) return up.response;
  const { mx, contentUri } = up;

  // Set as profile avatar
  const set = await setMatrixAvatarUrl(mx.homeserver, mx.matrixId, mx.accessToken, contentUri);
  if (!set) return new Response("Failed to set avatar", { status: 502 });

  // Mirror the mxc into site.users so the avatar read routes can serve it from
  // the DB without round-tripping the Matrix profile endpoint. Non-fatal.
  await pool.query(
    `UPDATE site.users SET avatar_url = $1 WHERE matrix_id = $2`,
    [contentUri, mx.matrixId]
  ).catch(() => {});

  return Response.json({ ok: true, avatar_url: contentUri });
}
