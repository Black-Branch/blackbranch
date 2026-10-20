import pool from "@/lib/db";
import { getMatrixSession } from "@/app/lib/matrixSession";
import { createCooldown } from "@/app/lib/rateLimit";
import { uploadImageToMatrixMedia } from "@/app/lib/matrixMediaUpload";
import { NextRequest } from "next/server";

// Profile BANNER upload — the strip behind the card's avatar. Same shared
// pipeline as api/avatar/upload (matrixMediaUpload.ts). Differences: a 6 MB
// cap (banners are wider than avatars), no Matrix profile write (a banner is a
// site-only concept — site.users.banner_mxc, v80, is the source of truth), and
// a DELETE handler to clear it.

// One upload per 60s per user, armed at check time (a failed upload still
// spends the slot — uploads are expensive regardless of outcome).
const uploadCooldown = createCooldown(60_000);

const MAX_BYTES = 6 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const up = await uploadImageToMatrixMedia(req, {
    field: "banner",
    maxBytes: MAX_BYTES,
    cooldown: uploadCooldown,
  });
  if (!up.ok) return up.response;
  const { mx, contentUri } = up;

  // Unlike the avatar (whose truth is the Matrix profile, with site.users as a
  // mirror), the DB row IS the banner — so a failed write is a failed upload,
  // not a best-effort miss.
  const wrote = await pool.query(
    `UPDATE site.users SET banner_mxc = $1 WHERE matrix_id = $2`,
    [contentUri, mx.matrixId]
  ).then(() => true).catch(() => false);
  if (!wrote) return new Response("Failed to save banner", { status: 500 });

  return Response.json({ ok: true, banner_mxc: contentUri });
}

export async function DELETE() {
  const mx = await getMatrixSession().catch(() => null);
  if (!mx) return new Response("Unauthorized", { status: 401 });

  const wrote = await pool.query(
    `UPDATE site.users SET banner_mxc = NULL WHERE matrix_id = $1`,
    [mx.matrixId]
  ).then(() => true).catch(() => false);
  if (!wrote) return new Response("Failed to clear banner", { status: 500 });

  return Response.json({ ok: true });
}
