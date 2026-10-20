import pool from "@/lib/db";

// The uploaded profile banner (site.users.banner_mxc, v80) behind a matrix id
// — the read /api/me and /api/user/[id] share. Best-effort by design: any
// error (e.g. a prod that hasn't applied v80 yet) resolves to null, so a
// banner can only be omitted, never break the caller's payload.
export async function getBannerMxc(matrixId: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ banner_mxc: string | null }>(
      `SELECT banner_mxc FROM site.users WHERE matrix_id = $1`,
      [matrixId]
    );
    return rows[0]?.banner_mxc ?? null;
  } catch {
    return null;
  }
}
