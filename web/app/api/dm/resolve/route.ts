import pool from "@/lib/db";
import { auth } from "@/auth";
import { NextRequest } from "next/server";
import { ACTIVE_BAN_SQL, DM_BANNED } from "@/app/lib/dm/banGate";

// GET ?q=<name> — the site accounts a typed name can mean, for `/dm <name>`. Signed-in only. A
// full Matrix id or an exact username wins outright; else every exact display name; else username /
// display-name prefixes. Never yourself, never a bot, never a deleted account. At most 6.

type Row = { matrix_id: string; display_name: string | null; rank: number };

const LIMIT = 6;

export async function GET(req: NextRequest) {
  const session = await auth().catch(() => null);
  const me = session?.user?.id;
  if (!me) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { rows: ban } = await pool.query(ACTIVE_BAN_SQL, [me]).catch(() => ({ rows: [] as unknown[] }));
  if (ban.length) return Response.json({ error: DM_BANNED }, { status: 403 });

  const raw = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 64);
  const name = raw.replace(/^@/, "").split(":")[0] ?? "";
  if (!name) return Response.json({ people: [] });
  const fullId = raw.startsWith("@") && raw.includes(":") ? raw : "";
  const prefix = `${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const { rows } = await pool.query<Row>(
    `SELECT matrix_id, display_name,
            CASE WHEN lower(matrix_id) = lower($1) THEN 0
                 WHEN lower(split_part(substr(matrix_id, 2), ':', 1)) = lower($2) THEN 1
                 WHEN lower(display_name) = lower($2) THEN 2
                 ELSE 3 END AS rank
       FROM site.users
      WHERE deleted_at IS NULL AND NOT is_bot AND matrix_id <> $3
        AND (lower(matrix_id) = lower($1)
             OR lower(split_part(substr(matrix_id, 2), ':', 1)) LIKE lower($4) ESCAPE '\\'
             OR lower(display_name) LIKE lower($4) ESCAPE '\\')
      ORDER BY rank, matrix_id
      LIMIT 50`,
    [fullId, name, me, prefix],
  ).catch(() => ({ rows: [] as Row[] }));

  const best = rows[0]?.rank;
  const picked = best === undefined ? []
    : best <= 1 ? rows.slice(0, 1)
    : rows.filter((r) => r.rank === best).slice(0, LIMIT);
  return Response.json({
    people: picked.map((r) => ({
      matrixId: r.matrix_id,
      username: r.matrix_id.slice(1).split(":")[0] ?? r.matrix_id,
      displayName: r.display_name,
    })),
  });
}
