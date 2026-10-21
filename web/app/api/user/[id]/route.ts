import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { streamApiFetch } from "@/app/lib/streamApi";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";
import { getBannerMxc } from "@/app/lib/bannerServer";
import { isNativePlatform } from "@/app/lib/nativePlatform";
import { linkFacts, viewerFacts } from "@/app/lib/linkFactsServer";
import { publicProfileFields, IDENTITY_STATS_SQL, identityStatsFields, type IdentityStatsRow } from "@/app/lib/publicProfile";
import { parsePublicId } from "@/app/lib/publicIdServer";
import { profileView } from "@/app/lib/profileView";
import { ERASED_CANONICAL } from "@/app/lib/erasedPerson";
import { pluginProfileFields } from "@/app/lib/plugins/profile";

// Public read — proxies stream-api /user/lookup so the web card shows the same profile as the
// !rank / !karma chat command. Only the fields a card renders leave (publicProfile.ts): never the
// exact support total, never what a site plugin adds.
//
// WHAT THE CARD MAY SAY is one decision, profileView.ts: a person's
// cross-platform link — which site account a Twitch name is, which platforms they are on — is shown
// only to the person, to moderators, and to everyone once the person switches on "show my linked
// platforms" (site.users.show_links, v153). This route never returns the linked Matrix id, site
// name or platform list for a canonical to anyone else.
//
// The id asked about is one of:
//   - a PUBLIC id (what every chat line carries — publicIdServer.ts): one person on one platform;
//   - a Matrix id (@user:server) — the site identity;
//   - a raw canonical — the LIVE path for a viewer's OWN card (profileCardPrefetch.ts asks with the
//     canonical /api/me returns), answered only for a moderator or the person themselves. Keep it:
//     it is not a leftover, and removing it blanks the own card.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawParam } = await params;
  if (!rawParam) return new Response("Bad Request", { status: 400 });
  let id = rawParam;
  try { id = decodeURIComponent(rawParam); } catch { /* keep raw */ }

  const pub = parsePublicId(id);
  const key: { kind: "public" | "matrix" | "canonical"; platform: string | null } = pub
    ? { kind: "public", platform: pub.platform }
    : id.startsWith("@") ? { kind: "matrix", platform: null } : { kind: "canonical", platform: null };
  const matrixKey = key.kind === "matrix" ? id : null;
  let canonicalId: string | null = pub ? pub.canonical : key.kind === "canonical" ? id : null;
  if (canonicalId === ERASED_CANONICAL) return Response.json({ found: false });

  // Matrix-shaped key → resolve the canonical stream id (may be absent: a site
  // account that never chatted while ingest was healthy and never linked a
  // platform has no stream identity — the profile lookup is skipped, but the
  // banner below still resolves directly off the matrix id).
  if (matrixKey) {
    try {
      const { rows } = await pool.query<{ canonical: string | null }>(
        `SELECT ${canonicalFromMatrixSql("$1")} AS canonical`,
        [matrixKey]
      );
      canonicalId = rows[0]?.canonical ?? null;
    } catch {
      /* no stream identity resolvable — banner-only response below */
    }
  }

  // Who is asking, and what this identity's link is (linkFactsServer.ts). Both fail closed. A
  // person looking at their own card is shown their OWN account, never another account that shares
  // the canonical (a split identity).
  const { viewer, isMod, isSelf } = await viewerFacts(canonicalId, matrixKey);
  if (key.kind === "canonical" && !isMod && !isSelf) return Response.json({ found: false });
  const { owner } = await linkFacts(canonicalId, matrixKey, isSelf ? viewer : null);
  const siteKey = key.kind === "matrix" || (key.kind === "public" && isNativePlatform(key.platform ?? ""));
  const view = profileView({ isMod, isSelf, showLinks: owner?.show_links === true, siteKey });

  // The stream profile. Failures do not short-circuit the response: the
  // banner lookup must run regardless, so a bannered user whose stream
  // lookup fails (stream-api down, no record) still renders their banner.
  const fetchProfile = async (): Promise<Record<string, unknown> | null> => {
    if (!canonicalId) return null;
    try {
      const res = await streamApiFetch(
        `/user/lookup?canonicalId=${encodeURIComponent(canonicalId)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        // A deleted person's canonical answers 404 or { erased: true }: both are "no profile".
        if (!body?.error && body?.erased !== true) return body;
      }
    } catch {
      /* stream-api unreachable — banner-only response below */
    }
    return null;
  };

  // The uploaded profile banner (site.users.banner_mxc, v80): the site account's own, so only on
  // a card the view lets show the site account.
  const fetchBanner = async (): Promise<string | null> => {
    if (matrixKey) return getBannerMxc(matrixKey);
    return owner ? getBannerMxc(owner.matrix_id) : null;
  };

  // Declared pronouns, behind view.links: they are held on the canonical — one value for every
  // platform the person is on — so on a stranger's card they would match across linked identities.
  // Per-platform pronouns would need a schema change; until then (accepted, low) a pronoun change
  // still shows on every platform's chat lines at once, as it always has. Best-effort.
  const fetchPronouns = async (): Promise<string | null> => {
    if (!canonicalId || !view.links) return null;
    try {
      const { rows } = await pool.query<{ pronouns: string | null }>(
        `SELECT pronouns FROM stream.users WHERE id = $1`, [canonicalId]);
      return rows[0]?.pronouns ?? null;
    } catch {
      return null;
    }
  };

  // The name this identity goes by on ITS platform — the stream profile's own name is the
  // canonical's, which may be another platform's (or the site's) name.
  const fetchPlatformName = async (): Promise<string | null> => {
    if (!canonicalId || key.kind !== "public" || siteKey) return null;
    try {
      const { rows } = await pool.query<{ username: string }>(
        `SELECT username FROM stream.chat_log WHERE user_id = $1 AND lower(platform) = $2 AND username IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`, [canonicalId, key.platform]);
      return rows[0]?.username ?? null;
    } catch {
      return null;
    }
  };

  // The stats of the ONE identity asked about, for a caller who may not see the merged ones — for
  // every person alike, linked or not, so a card's stats never say whether a link exists.
  const fetchIdentityStats = async (): Promise<Record<string, unknown>> => {
    if (!canonicalId || view.links) return {};
    try {
      const { rows } = await pool.query<IdentityStatsRow>(IDENTITY_STATS_SQL, [canonicalId, siteKey ? null : key.platform]);
      return identityStatsFields(rows[0]);
    } catch {
      return {};
    }
  };

  const [data, bannerMxc, pronouns, platformName, identityStats] = await Promise.all([
    fetchProfile(), view.site ? fetchBanner() : Promise.resolve(null), fetchPronouns(), fetchPlatformName(), fetchIdentityStats(),
  ]);

  // No stream profile → banner-only response. Deliberately BEFORE the link
  // enrichment: an enrichment throw must never blank a real profile.
  if (!data) {
    return Response.json({ found: false, ...(bannerMxc ? { bannerMxc } : {}) });
  }

  // The link fields, behind view.links (the person, a moderator, or their opt-in). The site
  // identity's own Matrix id (a site line's card) is behind view.site. Isolated in its OWN try so a
  // failure can only omit these fields, never discard the profile payload above.
  let matrixId: string | null = null;
  let siteName: string | null = null;
  let linkedPlatforms: string[] = [];
  let platformHandles: { platform: string; username: string }[] = [];
  try {
    if (view.site && siteKey) matrixId = matrixKey ?? owner?.matrix_id ?? null;
    if (view.links) {
      matrixId = matrixKey ?? owner?.matrix_id ?? null;
      siteName = owner?.display_name ?? null;
      const linkKey = matrixKey ?? owner?.matrix_id ?? null;
      if (linkKey) {
        const { rows } = await pool.query<{ platform: string }>(
          `SELECT DISTINCT platform FROM site.platform_links WHERE matrix_id = $1 ORDER BY platform`,
          [linkKey]
        );
        linkedPlatforms = rows.map((r) => r.platform);
      }
    }

    // ── Per-platform HANDLES — mods only ─────────────────────────────────────
    // The actual usernames a person holds on each platform: a whole identity graph on one card.
    // Gated SERVER-side (hiding them in the UI would publish them to anyone with devtools).
    // From chat_log — everyone who has ever chatted, under the name they appear as; DISTINCT ON
    // rides the chat_log_user_time (user_id, created_at DESC) index.
    if (canonicalId && isMod) {
      const { rows } = await pool.query<{ platform: string; username: string }>(
        `SELECT DISTINCT ON (platform) platform, username
           FROM stream.chat_log
          WHERE user_id = $1 AND username IS NOT NULL
          ORDER BY platform, created_at DESC`,
        [canonicalId]
      );
      platformHandles = rows.map((r) => ({ platform: r.platform, username: r.username }));
    }
  } catch {
    /* enrichment is best-effort — never let it strip the lookup payload */
  }
  // Merged stats (and the canonical's own `name`) only behind view.links; anyone else gets the one
  // identity's stats. The canonical's name can be another platform's (or the site's) name, so a
  // stranger's site card never carries it, and a platform card is named by its own platform.
  // The installed plugin's declared fields ride with the merged stats only (none without a plugin).
  // Trade-off: showing them to strangers for a single identity would be a one-line owner choice, but a
  // real value there means "not linked", so an active person's absent one would hint "linked" (D1).
  const fields = view.links ? publicProfileFields(data, pluginProfileFields()) : identityStats;
  return Response.json({
    found: true,
    ...fields,
    ...(platformName ? { name: platformName } : {}),
    ...(matrixId ? { matrixId } : {}),
    ...(siteName ? { siteName } : {}),
    ...(linkedPlatforms.length ? { linkedPlatforms } : {}),
    ...(platformHandles.length ? { platformHandles } : {}),
    ...(bannerMxc ? { bannerMxc } : {}),
    ...(pronouns ? { pronouns } : {}),
  });
}
