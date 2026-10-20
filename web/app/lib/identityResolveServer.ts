import { NATIVE_PLATFORM } from "./nativePlatform.ts";
// A site sign-in is the proof the identity model needs for the site's own
// platform. Called by both auth callbacks after the
// site.users insert, on EVERY sign-in — existing members get their canonical on
// their next sign-in, not after their first chat message.
//
// The name sent becomes stream.users.name (resolveOrCreate writes it on
// every hit), so it is the STORED display name; the localpart only when the
// person never set one. Sending the raw localpart would undo a chosen name at
// each sign-in.
//
// Best-effort by contract: a dead stream-api, a 5xx or a dead pool is one
// warning line, never a failed sign-in. A factory (the house pattern for
// server helpers under test): the callbacks hand it the real pool and
// streamApiFetch; the test hands it fakes.

/** The resolve call's own cap: a HUNG stream-api must not hold a sign-in for streamApiFetch's full 10 s. */
export const RESOLVE_TIMEOUT_MS = 2000;

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: { display_name: string | null }[] }> };
type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export function createIdentityResolver({ pool, fetch }: { pool: Pool; fetch: Fetch }) {
  return {
    async resolveSiteIdentity(matrixId: string): Promise<void> {
      try {
        const { rows } = await pool.query("SELECT display_name FROM site.users WHERE matrix_id = $1", [matrixId]);
        const stored = rows[0]?.display_name?.trim();
        const username = stored || (matrixId.split(":")[0] ?? matrixId).replace(/^@/, "");
        const res = await fetch("/identity/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: NATIVE_PLATFORM, userId: matrixId, username }),
        });
        if (!res.ok) console.warn("[identity] resolve at sign-in answered", res.status, "for", matrixId);
      } catch (e) {
        console.warn("[identity] resolve at sign-in failed for", matrixId, e instanceof Error ? e.message : e);
      }
    },
  };
}
