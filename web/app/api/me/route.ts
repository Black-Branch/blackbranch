import { auth } from "@/auth";
import pool from "@/lib/db";
import { isActiveStatus } from "@/app/lib/tiers";
import { isStaff } from "@/app/lib/staff";
import { getActiveTier } from "@/app/lib/entitlements";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";
import { getBannerMxc } from "@/app/lib/bannerServer";
import { matrixLocalpart } from "@/app/lib/chatIdentity";
import { readPresenceStatus } from "@/app/lib/presenceServer";
import { listViewerSubscriptions } from "@/app/lib/subscriptions/entitlement";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ signedIn: false, isMod: false });

  const { rows } = await pool.query(
    `SELECT u.is_mod, u.is_admin, u.display_name, u.display_name_changed_at, u.created_at, u.bio,
            s.tier, s.status, s.current_period_end, s.cancel_at_period_end,
            (SELECT MAX(g.expires_at) FROM site.gift_subscriptions g
             WHERE g.recipient_matrix_id = u.matrix_id AND g.expires_at > now()) AS gift_expires,
            -- Who gave the gift that ends last (the one the status line is
            -- about). Anonymous → NULL decided here, so the name never leaves
            -- the server. A gifter with no display name comes back as the raw
            -- @id and is shortened below.
            (SELECT CASE WHEN g.anonymous THEN NULL ELSE COALESCE(gu.display_name, g.gifter_matrix_id) END
             FROM site.gift_subscriptions g
             LEFT JOIN site.users gu ON gu.matrix_id = g.gifter_matrix_id
             WHERE g.recipient_matrix_id = u.matrix_id AND g.expires_at > now()
             ORDER BY g.expires_at DESC LIMIT 1) AS gift_from,
            -- Canonical stream identity (site.users has no such column — it lives
            -- in stream.links / site.platform_links). Lets a self-view ProfileCard
            -- that wasn't handed a canonicalId prop still load its stream stats.
            ${canonicalFromMatrixSql("u.matrix_id")} AS canonical_id
     FROM site.users u
     LEFT JOIN site.subscriptions s ON s.matrix_id = u.matrix_id
     WHERE u.matrix_id = $1`,
    [session.user.id]
  ).catch(() => ({ rows: [] as {
    is_mod: boolean; is_admin: boolean; display_name: string | null; display_name_changed_at: Date | null;
    created_at: Date | null; bio: string | null;
    tier: string | null; status: string | null; current_period_end: Date | null; cancel_at_period_end: boolean | null;
    gift_expires: Date | null; gift_from: string | null;
    canonical_id: string | null;
  }[] }));

  // Banner (v80). A SEPARATE, isolated query on purpose: getBannerMxc swallows
  // its own error, so a database without the column loses only the banner,
  // where folding banner_mxc into the main SELECT would null the WHOLE payload.
  const bannerMxc = await getBannerMxc(session.user.id);

  // Self-set presence status (v120) — the account card's picker reads it back.
  const presence = await readPresenceStatus(session.user.id);

  // Every subscription record the viewer holds, one per subscription per service (subscription
  // sources, v161) — the account page's list from S2. Isolated like the banner: a failed read loses
  // only the list. During S1 the billing fields below keep meaning "their own Stripe subscription".
  const subscriptions = await listViewerSubscriptions(pool, session.user.id).catch(() => []);

  // ── ENTITLEMENT vs BILLING — two different questions ────────────────────────
  //
  // `tier` below is the viewer's OWN Stripe subscription. A gift recipient has
  // no site.subscriptions row, so a perk check reading `tier` would treat them
  // as a non-supporter while the server (/api/chat/send gates on getActiveTier(),
  // which counts gifts) allows the action — two definitions of Supporter.
  //
  // So `supporter` is computed by the SAME function the server gates on, and
  // every sub-locked feature gets gifts right by asking it instead of `tier`.
  //
  // `tier` deliberately still means "has their own Stripe subscription" — the
  // billing UI keys "Manage subscription" off it, and a gift recipient has no
  // Stripe customer to manage, so widening `tier` would hand them a button that
  // can only error. Perks ask `supporter`; billing asks `tier`.
  const supporter = (await getActiveTier(session.user.id)) != null;

  const isMod = rows[0]?.is_mod || rows[0]?.is_admin || false;
  // Staff are comp Supporters by code (no fake DB date); a real subscription, if
  // any, still drives the displayed renewal date.
  const staff = isStaff(session.user.id);
  const subActive = staff || isActiveStatus(rows[0]?.status);
  const giftExpires = rows[0]?.gift_expires ?? null;
  return Response.json({
    signedIn: true,
    // The caller's own Matrix id (= their session id). Safe to expose to themselves;
    // the chat uses it to personalize a gift-sub announcement they're a recipient of.
    matrixId: session.user.id,
    // The caller's own canonical stream id (null if they've never chatted on a
    // linked platform). ProfileCard uses it as the stats source when no
    // canonicalId prop was passed (e.g. the /community mounts).
    canonicalId: rows[0]?.canonical_id ?? null,
    isMod,
    isAdmin: rows[0]?.is_admin || false,
    displayName: rows[0]?.display_name ?? null,
    displayNameChangedAt: rows[0]?.display_name_changed_at ?? null,
    // Account creation date — the profile card's "member since" line.
    memberSince: rows[0]?.created_at ?? null,
    // One-line about (site.users.bio, v126) — shown under the card's identity line.
    bio: rows[0]?.bio ?? null,
    // Uploaded profile banner (site.users.banner_mxc, v80), if any.
    bannerMxc,
    // Entitlement: does this viewer have Supporter perks RIGHT NOW, by any route
    // — own subscription, unexpired gift, or staff comp. This is the flag every
    // perk gate should read. See the note above for why it is not `tier`.
    supporter,
    // Billing: tier is only meaningful while the subscription is active (or staff).
    tier: subActive ? rows[0]?.tier ?? "supporter" : null,
    subStatus: rows[0]?.status ?? (staff ? "active" : null),
    subRenewsAt: rows[0]?.current_period_end ?? null,
    // Renewal switched off in the portal (v119). Only meaningful while the sub
    // is active — a lapsed row may still carry a stale true.
    subCancelAtPeriodEnd: subActive && Boolean(rows[0]?.cancel_at_period_end),
    // Gifted Supporter (received from someone else) — separate from an own sub.
    giftActive: Boolean(giftExpires),
    giftExpiresAt: giftExpires,
    // Who it came from; null when anonymous or unknown.
    giftFrom: giftFromDisplay(rows[0]?.gift_from),
    subscriptions,
    presenceStatus: presence.status,
    presenceStatusText: presence.statusText,
  });
}

// The SQL above returns a display name, or the raw @id when the gifter never
// set one. Shorten the latter by chatIdentity's one fallback rule.
function giftFromDisplay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.startsWith("@") ? matrixLocalpart(raw) : raw;
}
