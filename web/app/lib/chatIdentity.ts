import pool from "@/lib/db";
import { matrixLocalpart } from "./matrixConfig.ts";

// How a user should be rendered when the site announces something they did —
// a paid TTS, a soundboard clip, a sticker, a bot prompt, a donation, a sub.
//
// One query, error swallow and display-name fallback for every caller (the
// coins/spend endpoints and the billing webhook): separate copies of a
// name-resolution rule would be separate chances for a chat announcement to
// render someone differently from every other announcement about them.
//
// Deliberately NEVER throws. Every caller is a best-effort announce path that
// runs AFTER money has already moved — a failed lookup must degrade to the
// localpart, never turn a completed purchase into an error response.

export type ChatIdentity = {
  /** display_name if set, else the matrix localpart. Never empty. */
  username: string;
  usernameColor: string | null;
  usernameStyle: object | null;
};

type IdentityRow = {
  display_name: string | null;
  username_color: string | null;
  username_style: object | null;
};

/** "@name:<this server>" → "name": the fallback when there's no display_name (matrixConfig.ts). */
export { matrixLocalpart };

export async function getChatIdentity(matrixId: string): Promise<ChatIdentity> {
  const { rows } = await pool
    .query<IdentityRow>(
      `SELECT display_name, username_color, username_style FROM site.users WHERE matrix_id = $1`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as IdentityRow[] }));

  return {
    username: rows[0]?.display_name || matrixLocalpart(matrixId),
    usernameColor: rows[0]?.username_color ?? null,
    usernameStyle: rows[0]?.username_style ?? null,
  };
}
