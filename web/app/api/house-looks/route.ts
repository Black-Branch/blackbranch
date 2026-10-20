import { requireAdmin } from "@/app/lib/admin";
import pool from "@/lib/db";
import { sanitizeSettingsBlob } from "@/app/lib/settingsKeys";
import { migrateSettingsBlob } from "@/app/lib/settingsMigrate";
import { houseBlob } from "@/app/lib/houseLooks";
import { NextRequest } from "next/server";

// House looks (site.house_looks, migrate-v129): four site-wide looks that fill a
// viewer's EMPTY preset slots. GET is public — signed-out viewers get them too.
// PUT/DELETE are admin-only; the
// admin publishes from the preset row ("Make house look").
//
// houseBlob() runs on READ as well as write: a seeded row may hold an admin's
// saved look verbatim (name colour and Low power included), and stripping here
// means no copy of the key list lives in SQL.

const MAX_NAME_LEN = 40;
const MAX_BLOB_LEN = 16384;

type HouseRow = { slot: number; name: string | null; settings: Record<string, string> | null };

export async function GET() {
  const { rows } = await pool
    .query<HouseRow>(`SELECT slot, name, settings FROM site.house_looks ORDER BY slot`)
    .catch(() => ({ rows: [] }));
  const looks = rows.map((r) => ({
    slot: Number(r.slot),
    name: r.name ?? null,
    settings: houseBlob(migrateSettingsBlob(r.settings ?? {})),
  }));
  return Response.json({ looks });
}

export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => null);
  const slot = Number(body?.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    return new Response("Bad Request", { status: 400 });
  }
  let name: string | null = null;
  if (body?.name != null) {
    if (typeof body.name !== "string" || body.name.length > MAX_NAME_LEN) {
      return new Response("Bad Request", { status: 400 });
    }
    name = body.name.trim() || null;
  }
  const incoming = body?.settings;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return new Response("Bad Request", { status: 400 });
  }
  const clean = houseBlob(sanitizeSettingsBlob(incoming as Record<string, unknown>));
  if (JSON.stringify(clean).length > MAX_BLOB_LEN) {
    return new Response("Bad Request", { status: 400 });
  }

  // Publishing replaces the name too: the house look is a copy of the admin's
  // slot as it is now, name included (null = unnamed).
  const { rows } = await pool.query<HouseRow>(
    `INSERT INTO site.house_looks (slot, name, settings, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (slot)
     DO UPDATE SET name = EXCLUDED.name, settings = EXCLUDED.settings,
                   updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING slot, name, settings`,
    [slot, name, JSON.stringify(clean), admin]
  );
  const r = rows[0];
  if (!r) return new Response("Server Error", { status: 500 });
  return Response.json({ look: { slot: Number(r.slot), name: r.name ?? null, settings: r.settings ?? {} } });
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const slot = Number(req.nextUrl.searchParams.get("slot"));
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    return new Response("Bad Request", { status: 400 });
  }
  await pool.query(`DELETE FROM site.house_looks WHERE slot = $1`, [slot]);
  return Response.json({ ok: true });
}
