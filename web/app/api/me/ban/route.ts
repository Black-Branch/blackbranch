import { auth } from "@/auth";
import pool from "@/lib/db";

// Current user's active ban/timeout status — drives the countdown in the chat bar.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ banned: false });

  const { rows } = await pool.query(
    `SELECT expires_at FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [session.user.id]
  );
  if (rows.length === 0) return Response.json({ banned: false });
  return Response.json({ banned: true, expiresAt: rows[0].expires_at });
}
