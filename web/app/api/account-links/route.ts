import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { isModUser } from "@/app/lib/admin";
import { getConfiguredPlatforms, missingScopes } from "@/app/lib/platformOAuth";
import { viewerMayLink } from "@/app/lib/viewerLinks";
import { revokePlatformGrant } from "@/app/lib/platformRevoke";
import { decToken } from "@/app/lib/tokenCrypto";
import { createCooldown } from "@/app/lib/rateLimit";
import { streamApiFetch } from "@/app/lib/streamApi";
import { unlinkPlatformAccount } from "@/app/lib/platformUnlink";

type LinkedAccount = {
  platform: string;
  platformAccountId: string;
  displayName: string | null;
  linkedAt: string;
  scopes: string | null;
  /** Config scopes this link was granted WITHOUT — non-empty ⇒ relink upgrades it. */
  missingScopes: string[];
  /** The platform refused this link's refresh (v160, platformTokens.ts): it needs reconnecting. */
  expired: boolean;
};

export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const [{ rows }, isMod, showLinks] = await Promise.all([
    pool.query<{
      provider: string;
      provider_account_id: string;
      account_display_name: string | null;
      linked_at: Date;
      scope: string | null;
      refresh_failed_at: Date | null;
    }>(
      `SELECT provider, provider_account_id, account_display_name, linked_at, scope, refresh_failed_at
       FROM site.accounts
       WHERE matrix_id = $1 AND type IN ('oauth', 'atproto')
       ORDER BY linked_at DESC`,
      [matrixId]
    ),
    isModUser(),
    pool.query<{ show_links: boolean }>(`SELECT show_links FROM site.users WHERE matrix_id = $1`, [matrixId])
      .then((r) => r.rows[0]?.show_links === true).catch(() => false),
  ]);

  const accounts: LinkedAccount[] = rows.map(r => ({
    platform: r.provider,
    platformAccountId: r.provider_account_id,
    displayName: r.account_display_name,
    linkedAt: r.linked_at.toISOString(),
    scopes: r.scope,
    missingScopes: missingScopes(r.provider, r.scope, isMod),
    expired: r.refresh_failed_at !== null,
  }));

  // The env-derived platform availability, so the profile card's Linked
  // Accounts panel can render without its own server page.
  const configured: string[] = getConfiguredPlatforms().filter((p) => viewerMayLink(p));
  if (process.env.ATPROTO_PRIVATE_JWK) configured.push("streamplace");
  return Response.json({ accounts, configuredPlatforms: configured, showLinks });
}

// One switch per person per few seconds: each save rebuilds stream-api's sponsor pool.
const showLinksCooldown = createCooldown(3_000);

// PATCH { showLinks: boolean } — the person's own "show my linked platforms on my profile" switch
// (site.users.show_links, v153). Off by default: nobody else sees which
// platforms a person is on, or which site account a platform name is, until they turn this on.
// Mods see the link either way. Saving it tells stream-api, so the credit line follows at once.
export async function PATCH(req: Request) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = await req.json().catch(() => null) as { showLinks?: unknown } | null;
  if (typeof body?.showLinks !== "boolean") return Response.json({ error: "showLinks must be true or false" }, { status: 400 });
  if (showLinksCooldown.hit(matrixId)) {
    return Response.json({ error: "too_fast" }, { status: 429, headers: { "Retry-After": "3" } });
  }
  await pool.query(`UPDATE site.users SET show_links = $2 WHERE matrix_id = $1`, [matrixId, body.showLinks]);
  // Best-effort: the sponsor pool also re-checks every minute on its own.
  await streamApiFetch("/sponsors/links-changed", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }).catch(() => null);
  return Response.json({ ok: true, showLinks: body.showLinks });
}

export async function DELETE(req: Request) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null) as { platform?: string } | null;
  const platform = body?.platform;
  if (!platform || typeof platform !== "string") {
    return Response.json({ error: "missing_platform" }, { status: 400 });
  }

  // Separate the platform account's stream identity (stream-api /identity/unlink) BEFORE our rows
  // go, then revoke and delete — the order and every answer are platformUnlink.ts's. A failed
  // stream-api call removes nothing: 503, try again.
  const result = await unlinkPlatformAccount(matrixId, platform, {
    query: (sql, params) => pool.query(sql, params),
    streamUnlink: async (b) => (await streamApiFetch("/identity/unlink", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    })).status,
    revoke: revokePlatformGrant,
    decrypt: decToken,
  });
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status, headers: { "Retry-After": "5" } });
  }
  // Best-effort, like the switch above: the sponsor pool re-reads now, not at its next minute.
  await streamApiFetch("/sponsors/links-changed", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }).catch(() => null);

  return Response.json({ ok: true });
}
