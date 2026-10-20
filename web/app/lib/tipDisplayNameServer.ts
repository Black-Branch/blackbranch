// web/app/lib/tipDisplayNameServer.ts
//
// The display name a tip gets recorded under. Mirrors the donate route's rule
// exactly — extracted here so it can have a REAL unit test
// (tipDisplayNameServer.test.ts) rather than a source scan: route.ts imports
// the @/lib/db and @/auth aliases and cannot be executed under node --test at
// all (see orderRules.test.ts's header).
//
// The tip page renders a helper line telling a signed-in tipper their site
// name will be used when the name box is blank. Without this, the PayPal
// path would silently break that promise — the webhook only ever flips
// `status`, so this route's write is the FINAL word on display_name.
//
// Relative, not "@/lib/db": node --test loads this file directly (no
// bundler in the loop) and does not understand the tsconfig "@/*" alias —
// same reason paymentResultServer.ts and coinsServer.ts use this form.
import pool from "../../lib/db.ts";
import type { Pool } from "pg";

/** @parked consumed by the production binding below and by
 *  tipDisplayNameServer.test.ts; exported so the test can drive a fake pool,
 *  the same shape as paymentResultServer.ts's createPaymentResultServer. */
export function createTipDisplayNameServer(deps: { pool: Pool }) {
  async function resolveTipDisplayName(args: {
    matrixId: string | null;
    anonymous: boolean;
    rawName: string;
  }): Promise<string> {
    // Anonymity is checked FIRST, unconditionally — this is what makes it
    // win over both the backfill below AND a name the tipper actually typed
    // (donate/route.ts's own `anonymous ? "" : rawName` does the same thing
    // in one line; split out here only because the lookup needs its own
    // branch).
    if (args.anonymous) return "";
    if (args.rawName) return args.rawName;
    if (!args.matrixId) return "";
    // A database hiccup here must not fail the tip — fall back to an empty
    // label, exactly like donate/route.ts:86-89's
    // `.catch(() => ({ rows: [] as { display_name: string | null }[] }))`.
    const userRow = await deps.pool
      .query<{ display_name: string | null }>(
        `SELECT display_name FROM site.users WHERE matrix_id = $1`,
        [args.matrixId],
      )
      .catch(() => ({ rows: [] as { display_name: string | null }[] }));
    return userRow.rows[0]?.display_name ?? "";
  }
  return { resolveTipDisplayName };
}

export const resolveTipDisplayName = createTipDisplayNameServer({ pool }).resolveTipDisplayName;
