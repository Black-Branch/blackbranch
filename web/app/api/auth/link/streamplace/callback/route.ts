// Complete stream.place (AT Protocol) linking. The library validates OAuth state
// against the StateStore and persists the DPoP session in the SessionStore keyed
// by DID; we record the link in site.accounts + bridge to the stream identity,
// mirroring the OAuth2 callback.
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAtprotoClient } from "@/app/lib/atprotoClient";
import { streamApiFetch } from "@/app/lib/streamApi";
import pool from "@/lib/db";
import { authOrigin } from "@/app/lib/authOrigin";
import { HELD_BY_OTHER_SQL } from "@/app/lib/platformAccountLink";

// Derived, not hardcoded — see authOrigin.ts.
const BASE_URL = authOrigin();
// "/" with params intact — same three-leg contract as [platform]/callback
// (oauthBannerSurface.test.ts): the old /settings/accounts landing dropped
// the query string before the banner could render.
const SUCCESS_URL = `${BASE_URL}/`;

function errRedirect(reason: string) {
  return NextResponse.redirect(new URL(`${SUCCESS_URL}?error=${reason}&platform=streamplace`, BASE_URL));
}

export async function GET(req: NextRequest) {
  let did: string;
  let matrixId: string | undefined;
  let handle: string | undefined;

  try {
    const client = await getAtprotoClient();
    const { session, state } = await client.callback(req.nextUrl.searchParams);
    did = session.did;
    if (state) {
      const parsed = JSON.parse(state) as { matrixId?: string; handle?: string };
      matrixId = parsed.matrixId;
      handle = parsed.handle;
    }
  } catch (e) {
    console.error("[link:streamplace:callback]", e);
    return errRedirect("atproto_callback_failed");
  }

  // Verify the logged-in user matches who initiated the flow.
  const authSession = await auth();
  if (!authSession?.user?.id || authSession.user.id !== matrixId) {
    return errRedirect("session_mismatch");
  }

  // One platform account, one site account: refuse a DID another account holds, or one a deleted
  // account left under a ban or an open case — the same answer the OAuth callback gives.
  const { rows: held } = await pool.query<{ matrix_id: string }>(HELD_BY_OTHER_SQL, ["streamplace", did, matrixId]);
  if (held.length) return errRedirect("already_linked");

  // Record the link (the DPoP session itself lives in the SessionStore by DID).
  await pool.query(
    `INSERT INTO site.accounts
       (matrix_id, type, provider, provider_account_id,
        access_token, refresh_token, expires_at, token_type, scope,
        linked_at, account_display_name)
     VALUES ($1, 'atproto', 'streamplace', $2, NULL, NULL, NULL, NULL, $3, now(), $4)
     ON CONFLICT (provider, provider_account_id) DO UPDATE SET
       matrix_id            = EXCLUDED.matrix_id,
       scope                = EXCLUDED.scope,
       linked_at            = now(),
       account_display_name = EXCLUDED.account_display_name`,
    [matrixId, did, "atproto transition:generic", handle ?? did]
  );

  // Bridge to the canonical stream identity (same as the OAuth2 callback).
  const { rows } = await pool.query<{ canonical: string }>(
    `SELECT canonical FROM stream.links WHERE platform = 'streamplace' AND platform_id = $1 LIMIT 1`,
    [did]
  );
  const canonicalId = rows[0]?.canonical ?? null;
  if (canonicalId) {
    await pool.query(
      `INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id)
       VALUES ($1, 'streamplace', $2, $3)
       ON CONFLICT (matrix_id, platform) DO UPDATE SET
         platform_id  = EXCLUDED.platform_id,
         canonical_id = EXCLUDED.canonical_id`,
      [matrixId, did, canonicalId]
    );

    // Unify this person's canonicals (see the OAuth2 callback). Best-effort.
    streamApiFetch("/identity/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matrixId }),
    }).catch(() => {});
  }

  return NextResponse.redirect(new URL(`${SUCCESS_URL}?linked=streamplace`, BASE_URL));
}
