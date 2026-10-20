import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { isStaff } from "@/app/lib/staff";
import { notifyBadgesChanged } from "@/app/lib/streamApi";
import { MAX_SLOTS } from "@/app/lib/badgeSlots";
import { NextRequest } from "next/server";
import { invalidateBadgeSnapshot } from "@/app/lib/badgeCache";

// POST /api/badges/equip { slotIndex, badgeId|null }
// Self-service: the signed-in user equips one of THEIR unlocked badges into one of
// THEIR unlocked slots (or clears it with badgeId:null). Validates both the slot
// (index below the user's live effective count) and the badge (must be unlocked).
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const slotIndex = Number((body as { slotIndex?: unknown } | null)?.slotIndex);
  const rawBadge = (body as { badgeId?: unknown } | null)?.badgeId;
  const badgeId = rawBadge == null ? null : Number(rawBadge);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return new Response("Bad slot", { status: 400 });
  }
  if (badgeId !== null && (!Number.isInteger(badgeId) || badgeId <= 0)) {
    return new Response("Bad badge", { status: 400 });
  }

  // Effective slot count + unlock check in one round-trip.
  const { rows } = await pool.query<{ base: number; entitled: boolean; unlocked: boolean; sub_gated: boolean }>(
    `SELECT
       COALESCE(bs.base_slots, 0) AS base,
       ( EXISTS (SELECT 1 FROM site.subscriptions s
                  WHERE s.matrix_id = $1 AND s.status IN ('active','trialing','past_due'))
         OR EXISTS (SELECT 1 FROM site.gift_subscriptions g
                     WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()) ) AS entitled,
       EXISTS (SELECT 1 FROM site.badge_unlocks bu
                WHERE bu.matrix_id = $1 AND bu.badge_id = $2) AS unlocked,
       COALESCE((SELECT b.is_subscriber FROM site.badges b WHERE b.id = $2), false) AS sub_gated
     FROM (SELECT 1) x
     LEFT JOIN site.badge_slots bs ON bs.matrix_id = $1`,
    [matrixId, badgeId ?? 0]
  ).catch(() => ({ rows: [] as { base: number; entitled: boolean; unlocked: boolean; sub_gated: boolean }[] }));

  const base = Number(rows[0]?.base ?? 0);
  const entitled = !!rows[0]?.entitled || isStaff(matrixId);
  const slotCount = Math.min(MAX_SLOTS, base + (entitled ? 1 : 0));
  if (slotIndex >= slotCount) return new Response("Slot locked", { status: 403 });
  if (badgeId !== null && !rows[0]?.unlocked) return new Response("Badge locked", { status: 403 });

  // A subscriber-gated badge needs LIVE entitlement at equip time, not just an
  // unlock row. site.badge_unlocks is a permanent record of "you once earned
  // this" and is never revoked, so a lapsed subscriber who separately bought a
  // Qorm badge slot could re-equip the Supporter badge forever and keep wearing
  // it in chat with no subscription behind it. Staff bypass, as everywhere else.
  if (badgeId !== null && rows[0]?.sub_gated && !entitled) {
    return new Response("Subscription required", { status: 403 });
  }

  // Ensure a row, then set the 1-based slot element (assigning past the array end
  // pads with NULLs; badgeId=null clears the slot).
  await pool.query(
    `INSERT INTO site.badge_slots (matrix_id, equipped) VALUES ($1, '{}') ON CONFLICT (matrix_id) DO NOTHING`,
    [matrixId]
  );
  await pool.query(
    `UPDATE site.badge_slots SET equipped[$2] = $3, updated_at = now() WHERE matrix_id = $1`,
    [matrixId, slotIndex + 1, badgeId]
  );

  invalidateBadgeSnapshot();
  void notifyBadgesChanged();
  return Response.json({ ok: true });
}
