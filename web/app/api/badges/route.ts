import pool from "@/lib/db";
import { auth } from "@/auth";
import { requireAdmin } from "@/app/lib/admin";
import { resetSubscriberBadgeCache, reassignSubscriberBadge } from "@/app/lib/billingServer";
import { notifyBadgesChanged } from "@/app/lib/streamApi";
import { staffMatrixIds } from "@/app/lib/staff";
import { MAX_SLOTS, shapeBadgeUserState, type BadgeUserState } from "@/app/lib/badgeSlots";
import { getBadgeSnapshot, invalidateBadgeSnapshot } from "@/app/lib/badgeCache";
import { etagFor, etagMatches, publicBadgeImageUrl } from "@/app/lib/badgeImage";
import { NextRequest } from "next/server";

// Chat badges. GET is public (the chat needs the badge map to render). POST/DELETE/
// PATCH manage badge DEFINITIONS and are admin-only. Assigning badges to
// users is gone — users EQUIP their own unlocked badges (see badge_slots, v60).

// GET /api/badges →
//   { catalog:[{id,name,imageUrl,isSubscriber,isMod}], subscriberBadgeId, modBadgeId,
//     maxSlots, perUser:{ [matrixId]: { slotCount, equipped, unlocked, isMod } } }
export async function GET(req: NextRequest) {
  // Who is asking — a user's UNLOCKED-but-unequipped badges are private (they
  // reveal what someone bought/earned but chose not to display), and are only
  // ever rendered for the signed-in user's own equip palette. So the full
  // `unlocked` list is returned for self only; everyone else gets []. Equipped
  // badges + the mod flag stay public — those already render in chat for all.
  const me = (await auth())?.user?.id ?? null;
  // Six full-table scans, none of them per-caller, on an endpoint every client
  // polls every 60s. Shared snapshot, short TTL, invalidated by every
  // write path — see badgeCache.ts. Only the shaping below is per-caller.
  const { cat, slots, unlocks, mods, subs, gifts } = await getBadgeSnapshot();

  const catalog = cat.map((d) => ({
    // A URL, not the stored data URI: the image is served once from
    // /api/badges/image/<id>/<hash>.<ext> and cached forever. Same field, same rendering.
    id: Number(d.id), name: d.name, imageUrl: publicBadgeImageUrl(Number(d.id), d.image_url),
    isSubscriber: !!d.is_subscriber, isMod: !!d.is_mod,
    // Coin-purchasable badges (v67 store) surface their price; null = not for sale.
    coinPrice:
      d.unlock_criteria?.type === "coin" && Number(d.unlock_criteria.price) > 0
        ? Math.round(Number(d.unlock_criteria.price))
        : null,
  }));
  const subscriberBadgeId = catalog.find((c) => c.isSubscriber)?.id ?? null;
  const modBadgeId = catalog.find((c) => c.isMod)?.id ?? null;

  // Entitled = own active subscription OR unexpired gift OR staff (comp).
  const entitled = new Set<string>(staffMatrixIds());
  for (const r of subs) if (r.matrix_id) entitled.add(r.matrix_id);
  for (const r of gifts) if (r.matrix_id) entitled.add(r.matrix_id);

  // Staff (the streamer and the bot) are excluded from the AUTO mod badge — they still have
  // full mod powers everywhere else (every mod-gated route checks is_mod/is_admin
  // directly, not this set), but their chat badges are curated by hand instead
  // of auto-assigned (see staff.ts's isStaff doc comment — this closes the gap
  // where that promise wasn't actually enforced for the mod badge specifically).
  const modSet = new Set(mods.map((r) => r.matrix_id).filter((id) => !staffMatrixIds().has(id)));
  const unlockedBy: Record<string, number[]> = {};
  for (const r of unlocks) (unlockedBy[r.matrix_id] ??= []).push(Number(r.badge_id));

  const slotRow: Record<string, { base: number; equipped: (number | null)[] }> = {};
  for (const r of slots) {
    slotRow[r.matrix_id] = {
      base: Number(r.base_slots) || 0,
      equipped: (r.equipped ?? []).map((x) => (x == null ? null : Number(x))),
    };
  }

  const ids = new Set<string>([
    ...modSet, ...entitled, ...Object.keys(unlockedBy), ...Object.keys(slotRow),
  ]);
  // PRESENCE IS THE LEAK. `ids` unions mods, entitled subscribers, gift
  // recipients and anyone owning an unlock — so simply APPEARING in perUser
  // would mark someone as a subscriber/gift-recipient/mod, and this endpoint is
  // public and polled by every client. Blanking `unlocked` alone hides the
  // inventory but not the membership: a subscriber who equips nothing would
  // still show up carrying slotCount = base + 1, which is the subscription.
  //
  // So for anyone other than the caller, return only what chat ALREADY renders
  // publicly — the mod badge and the equipped badges — and omit users who would
  // render nothing at all. badgesForMatrixId() returns [] for a missing entry,
  // exactly as it does for an entry with nothing to show.
  //
  // Consequence: another user's UserCard shows the badges they DISPLAY, not the
  // number of slots they OWN. Owning an unequipped slot is the entitlement signal.
  // Badges that require LIVE entitlement to wear — the shaper
  // masks them out of `equipped` for lapsed users; see shapeBadgeUserState.
  const subscriberBadgeIds = new Set(cat.filter((d) => d.is_subscriber).map((d) => Number(d.id)));

  const perUser: Record<string, BadgeUserState> = {};
  for (const mid of ids) {
    const base = slotRow[mid]?.base ?? 0;
    const shaped = shapeBadgeUserState({
      isSelf: mid === me,
      ownedSlotCount: Math.min(MAX_SLOTS, base + (entitled.has(mid) ? 1 : 0)),
      equipped: slotRow[mid]?.equipped ?? [],
      unlocked: unlockedBy[mid] ?? [],
      isMod: modSet.has(mid),
      entitled: entitled.has(mid),
      subscriberBadgeIds,
    });
    if (shaped) perUser[mid] = shaped;
  }

  // A strong ETag over the exact body, so an unchanged poll (every 60 s + focus, from every tab)
  // is a bodiless 304. `private`: the body depends on who asks (their own
  // `unlocked`), so no shared cache may keep it; `no-cache`: always revalidate. The client needs
  // no change — a plain fetch() revalidates through the browser's HTTP cache by itself.
  const body = JSON.stringify({ catalog, subscriberBadgeId, modBadgeId, maxSlots: MAX_SLOTS, perUser });
  const etag = etagFor(body);
  const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie" };
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}

// POST /api/badges { name, imageUrl } → create a badge (admin only)
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
  if (!name || name.length > 60) return new Response("Bad name", { status: 400 });
  // Accept a small data: URL or a same-origin/relative path; cap size so a stray
  // upload can't bloat the row (≈100KB of base64 covers any sane badge icon).
  const okUrl = (imageUrl.startsWith("data:image/") || imageUrl.startsWith("/") || imageUrl.startsWith("https://"));
  if (!okUrl || imageUrl.length > 100_000) return new Response("Bad image", { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO site.badges (name, image_url) VALUES ($1, $2) RETURNING id`,
    [name, imageUrl]
  );
  invalidateBadgeSnapshot();
  return Response.json({ ok: true, id: Number(rows[0].id) });
}

// DELETE /api/badges?id=<n> → delete a badge def (admin only). Unlocks/equips
// referencing it cascade (badge_unlocks FK); equipped[] entries are cleaned lazily.
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad id", { status: 400 });
  await pool.query(`DELETE FROM site.badges WHERE id = $1`, [id]);
  // Drop the deleted badge from any equipped slot so it stops rendering.
  await pool.query(
    `UPDATE site.badge_slots SET equipped = array_replace(equipped, $1::bigint, NULL) WHERE $1 = ANY(equipped)`,
    [id]
  ).catch(() => {});
  invalidateBadgeSnapshot();
  void notifyBadgesChanged();
  return Response.json({ ok: true });
}

// PATCH /api/badges?id=<n>  body { subscriber:true } | { mod:true } → designate the
// badge that represents Supporter, or the fixed mod badge (admin only). Each flag is
// single-holder (partial unique index); flip in two statements so it's never violated.
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad id", { status: 400 });
  const body = await req.json().catch(() => null);

  const exists = await pool.query(`SELECT 1 FROM site.badges WHERE id = $1`, [id]);
  if (exists.rowCount === 0) return new Response("No such badge", { status: 404 });

  // { coinPrice: N } prices the badge in the coin store (unlock_criteria, v67);
  // { coinPrice: null } takes it off sale. Supporter and mod badges can't be sold.
  if (body && "coinPrice" in body) {
    const raw = (body as { coinPrice: unknown }).coinPrice;
    const price = raw == null ? null : Math.round(Number(raw));
    if (price !== null && (!Number.isFinite(price) || price <= 0 || price > 1_000_000)) {
      return new Response("Bad price", { status: 400 });
    }
    if (price !== null) {
      const special = await pool.query(
        `SELECT 1 FROM site.badges WHERE id = $1 AND (is_subscriber OR is_mod)`, [id]
      );
      if ((special.rowCount ?? 0) > 0) return new Response("Supporter and mod badges can't be sold", { status: 400 });
    }
    await pool.query(
      `UPDATE site.badges SET unlock_criteria = $2 WHERE id = $1`,
      [id, price === null ? null : JSON.stringify({ type: "coin", price })]
    );
    return Response.json({ ok: true });
  }

  if (body?.mod === true) {
    await pool.query(`UPDATE site.badges SET is_mod = false WHERE is_mod`);
    await pool.query(`UPDATE site.badges SET is_mod = true WHERE id = $1`, [id]);
    void notifyBadgesChanged();
    return Response.json({ ok: true });
  }

  if (body?.subscriber !== true) return new Response("Nothing to do", { status: 400 });

  // Remember the outgoing subscriber badge so we can migrate holders.
  const prev = await pool
    .query(`SELECT id FROM site.badges WHERE is_subscriber LIMIT 1`)
    .catch(() => ({ rows: [] as { id: number }[] }));
  const oldId = prev.rows[0]?.id != null ? Number(prev.rows[0].id) : null;

  await pool.query(`UPDATE site.badges SET is_subscriber = false WHERE is_subscriber`);
  await pool.query(`UPDATE site.badges SET is_subscriber = true WHERE id = $1`, [id]);

  resetSubscriberBadgeCache();
  await reassignSubscriberBadge(id, oldId);
  invalidateBadgeSnapshot();
  void notifyBadgesChanged();
  return Response.json({ ok: true });
}
