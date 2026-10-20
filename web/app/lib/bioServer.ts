// The own card's one-line "about" (site.users.bio). Same sanitiser as the
// presence status line, longer cap. A factory (house pattern): the route hands
// it the real pool, the test a fake.
// .ts extension on purpose: bioServer.test.ts loads this under node --test.
import { sanitizeChatMessage } from "./sanitize.ts";

/** @test-only used by sanitizeBio below; the test pins the 200 the spec names. */
export const BIO_MAX = 200;

/** @test-only used by setBio below; exported so the one-line/200-char rule is pinned on its own. */
export function sanitizeBio(raw: unknown): string {
  return typeof raw === "string" ? sanitizeChatMessage(raw, BIO_MAX) : "";
}

type Pool = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export function createBioServer({ pool }: { pool: Pool }) {
  return {
    /** Stores the sanitised bio (NULL when empty) and returns what was stored. */
    async setBio(matrixId: string, raw: unknown): Promise<string> {
      const bio = sanitizeBio(raw);
      await pool.query("UPDATE site.users SET bio = $1 WHERE matrix_id = $2", [bio || null, matrixId]);
      return bio;
    },
  };
}
