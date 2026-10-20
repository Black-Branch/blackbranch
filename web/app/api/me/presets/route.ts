import { requireUser } from "@/app/lib/authGuard";
import pool from "@/lib/db";
import { sanitizeSettingsBlob } from "@/app/lib/settingsKeys";
import { migrateSettingsBlob } from "@/app/lib/settingsMigrate";
import { NextRequest } from "next/server";

// Account-roaming preset slots (site.setting_presets, migrate-v79). Unlike the
// per-device-class active config in /api/me/settings, presets are a single
// list shared across every device on the account — save on desktop, apply on
// phone. Each slot is a whole-config snapshot (same shape as the active blob),
// so the 256-char/value cap doesn't apply per-key here; the whole blob is
// capped instead (see PUT).

const MAX_SLOT = 4;
const MAX_NAME_LEN = 40;
const MAX_BLOB_LEN = 16384;

type PresetRow = { slot: number; name: string | null; settings: Record<string, string> };

export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const { rows } = await pool.query(
    `SELECT slot, name, settings FROM site.setting_presets WHERE matrix_id = $1 ORDER BY slot`,
    [matrixId]
  );
  const presets: PresetRow[] = rows.map((r) => ({
    slot: Number(r.slot),
    name: r.name ?? null,
    settings: migrateSettingsBlob(r.settings ?? {}),
  }));
  return Response.json({ presets });
}

export async function PUT(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const slot = Number(body?.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    return new Response("Bad Request", { status: 400 });
  }

  let name: string | null = null;
  if (body?.name != null) {
    if (typeof body.name !== "string" || body.name.length > MAX_NAME_LEN) {
      return new Response("Bad Request", { status: 400 });
    }
    name = body.name;
  }

  const incoming = body?.settings;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Same whitelist-and-coerce policy as /api/me/settings (shared helper), plus
  // a whole-blob cap since this is a full snapshot.
  const clean = sanitizeSettingsBlob(incoming as Record<string, unknown>);
  if (JSON.stringify(clean).length > MAX_BLOB_LEN) {
    return new Response("Bad Request", { status: 400 });
  }

  const { rows } = await pool.query(
    `INSERT INTO site.setting_presets (matrix_id, slot, name, settings, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (matrix_id, slot)
     DO UPDATE SET
       name = COALESCE($3, site.setting_presets.name),
       settings = EXCLUDED.settings,
       updated_at = now()
     RETURNING slot, name, settings`,
    [matrixId, slot, name, JSON.stringify(clean)]
  );
  const r = rows[0];
  return Response.json({ preset: { slot: Number(r.slot), name: r.name ?? null, settings: r.settings ?? {} } });
}

export async function DELETE(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const slot = Number(req.nextUrl.searchParams.get("slot"));
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    return new Response("Bad Request", { status: 400 });
  }

  await pool.query(
    `DELETE FROM site.setting_presets WHERE matrix_id = $1 AND slot = $2`,
    [matrixId, slot]
  );
  return Response.json({ ok: true });
}
