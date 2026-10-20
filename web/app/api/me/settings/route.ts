import { auth } from "@/auth";
import { requireUser } from "@/app/lib/authGuard";
import pool from "@/lib/db";
import { sanitizeSettingsBlob } from "@/app/lib/settingsKeys";
import { migrateSettingsBlob } from "@/app/lib/settingsMigrate";
import { NextRequest } from "next/server";

// Cross-device chat/appearance settings. localStorage is the per-device fast
// path; this endpoint is the durable copy keyed by (Matrix ID, device class)
// (site.user_settings, migrate-v33 + v79). The active config is per device
// class — desktop and mobile keep their own blob — so a font/layout change
// made on a phone doesn't clobber the desktop config (and vice versa). GET
// hydrates, PUT upserts the whole blob for the requested class.
//
// ?device_class=desktop|mobile — absent/invalid defaults to "desktop" for
// backward compatibility with callers that predate this param.

const DEVICE_CLASSES = new Set(["desktop", "mobile"]);

function resolveDeviceClass(req: NextRequest): "desktop" | "mobile" {
  const raw = req.nextUrl.searchParams.get("device_class");
  return DEVICE_CLASSES.has(raw ?? "") ? (raw as "desktop" | "mobile") : "desktop";
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ settings: null, authed: false });
  const deviceClass = resolveDeviceClass(req);
  const { rows } = await pool.query(
    `SELECT settings FROM site.user_settings WHERE matrix_id = $1 AND device_class = $2`,
    [session.user.id, deviceClass]
  ).catch(() => ({ rows: [] as { settings: Record<string, unknown> }[] }));
  return Response.json({ settings: rows[0]?.settings ? migrateSettingsBlob(rows[0].settings) : null, authed: true });
}

export async function PUT(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const deviceClass = resolveDeviceClass(req);
  const body = await req.json().catch(() => null);
  const incoming = body?.settings;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Whitelist + coerce (shared with the presets route — see settingsKeys.ts).
  const clean = sanitizeSettingsBlob(incoming as Record<string, unknown>);

  await pool.query(
    `INSERT INTO site.user_settings (matrix_id, device_class, settings, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (matrix_id, device_class)
     DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [matrixId, deviceClass, JSON.stringify(clean)]
  );
  return Response.json({ ok: true });
}
