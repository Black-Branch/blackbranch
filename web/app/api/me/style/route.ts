import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { styleById, type EquippedStyle, type StyleCategory } from "@/app/lib/usernameStyles";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// The signed-in user's equipped username-style SET (migrate-v68): at most one
// owned style per category { font, effect, entrance, gradient }, stored as jsonb in
// site.users.username_style. GET → { style, unlocked } · PATCH takes a partial
// per-category update ({ gradient: "duo" } equips; { gradient: null } clears)
// plus an optional { gradientColor: "#rrggbb" | null } — the user-picked second
// stop for the "duo" gradient — and returns the full new set. Plain
// username_color stays independent + free — effects/gradients derive from it
// at render time.

const CATEGORIES: StyleCategory[] = ["font", "effect", "entrance", "gradient"];

export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const [me, owned] = await Promise.all([
    pool.query<{ username_style: EquippedStyle | null }>(
      `SELECT username_style FROM site.users WHERE matrix_id = $1`, [matrixId]
    ),
    pool.query<{ style_id: string }>(
      `SELECT style_id FROM site.user_style_unlocks WHERE matrix_id = $1`, [matrixId]
    ),
  ]);
  return Response.json({
    style: me.rows[0]?.username_style ?? null,
    unlocked: owned.rows.map((r) => r.style_id),
  });
}

export async function PATCH(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = (await req.json().catch(() => null)) as
    (Partial<Record<StyleCategory, unknown>> & { gradientColor?: unknown }) | null;
  if (!body || (!CATEGORIES.some((c) => c in body) && !("gradientColor" in body)))
    return new Response("Bad Request", { status: 400 });

  // The duo gradient's second stop: any valid hex; render clamps via readableColor.
  let gradientColor: string | null | undefined;
  if ("gradientColor" in body) {
    const raw = body.gradientColor;
    if (raw === null) gradientColor = null;
    else if (typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw)) gradientColor = raw;
    else return new Response("Bad color", { status: 400 });
  }

  // Validate every touched category up front: null clears; a string must be an
  // owned style of THAT category.
  const changes: Partial<Record<StyleCategory, string | null>> = {};
  const wantIds: string[] = [];
  for (const cat of CATEGORIES) {
    if (!(cat in body)) continue;
    const raw = body[cat];
    if (raw === null) { changes[cat] = null; continue; }
    const style = typeof raw === "string" ? styleById(raw) : null;
    if (!style || style.category !== cat) return new Response("Bad style", { status: 400 });
    wantIds.push(style.id);
    changes[cat] = style.id;
  }

  // One batched ownership check + the current-style read in parallel (they're
  // independent), same Promise.all pattern as this file's GET — instead of one
  // sequential ownership query per touched category.
  const [ownedRes, currentRes] = await Promise.all([
    wantIds.length
      ? pool.query<{ style_id: string }>(
          `SELECT style_id FROM site.user_style_unlocks WHERE matrix_id = $1 AND style_id = ANY($2)`,
          [matrixId, wantIds]
        )
      : Promise.resolve({ rows: [] as { style_id: string }[] }),
    pool.query<{ username_style: EquippedStyle | null }>(
      `SELECT username_style FROM site.users WHERE matrix_id = $1`, [matrixId]
    ),
  ]);
  const ownedIds = new Set(ownedRes.rows.map((r) => r.style_id));
  if (wantIds.some((id) => !ownedIds.has(id))) return new Response("Style locked", { status: 403 });
  const current: EquippedStyle = currentRes.rows[0]?.username_style ?? {};
  const next: EquippedStyle = { ...current, ...changes };
  if (gradientColor !== undefined) next.gradientColor = gradientColor;
  for (const cat of CATEGORIES) if (next[cat] == null) delete next[cat];
  if (next.gradientColor == null) delete next.gradientColor;
  const empty = !next.font && !next.effect && !next.entrance && !next.gradient;

  await pool.query(
    `UPDATE site.users SET username_style = $2 WHERE matrix_id = $1`,
    [matrixId, empty ? null : JSON.stringify(next)]
  );
  return Response.json({ ok: true, style: empty ? null : next });
}
