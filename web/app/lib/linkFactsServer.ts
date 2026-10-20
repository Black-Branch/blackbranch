// The facts profileView.ts decides on, read for one identity and one caller. Shared by the public
// profile card (/api/user/[id]) and the public social-credit read (/api/user/credit), so both
// answer the same question — may this caller see this person's cross-platform link? — the same way.
import { auth } from "@/auth";
import pool from "@/lib/db";
import { resolveIdentities } from "@/lib/socialCredit";
import { isModUser } from "@/app/lib/admin";
import { IDENTITY_SPAN_SQL, LINK_OWNER_SQL } from "@/app/lib/identitySpan";

export type LinkOwner = { matrix_id: string; display_name: string | null; show_links: boolean };

/** Who is asking: their Matrix id, whether they moderate, and whether they ARE the identity
 *  (`matrixKey` asked about, or a canonical their account covers — EVERY linked identity, the
 *  permission question). A card shown to them as "self" names their OWN account (linkFacts' `self`),
 *  never another account sharing the canonical. Fails closed: a session or lookup that cannot be
 *  read is a stranger. */
export async function viewerFacts(canonical: string | null, matrixKey: string | null): Promise<{ viewer: string | null; isMod: boolean; isSelf: boolean }> {
  const session = await auth().catch(() => null);
  const viewer = session?.user?.id ?? null;
  if (!viewer) return { viewer: null, isMod: false, isSelf: false };
  const isMod = await isModUser().catch(() => false);
  let isSelf = matrixKey === viewer;
  if (!isSelf && canonical) {
    const mine = await resolveIdentities({ matrixId: viewer }).catch(() => ({ canonicalIds: [] as string[] }));
    isSelf = mine.canonicalIds.includes(canonical);
  }
  return { viewer, isMod, isSelf };
}

/** The site account behind an identity (either link table; LINK_OWNER_SQL picks ONE — the caller's
 *  own when `self`, the caller's Matrix id, is set because they are the person), and whether it
 *  shows its links: true only when every account in the whole identity agrees (IDENTITY_SPAN_SQL).
 *  A failed read is the most private answer: no owner. */
export async function linkFacts(canonical: string | null, matrixKey: string | null, self: string | null = null): Promise<{ owner: LinkOwner | null }> {
  try {
    let owner: LinkOwner | null = null;
    if (matrixKey) {
      const { rows } = await pool.query<LinkOwner>(
        `SELECT u.matrix_id, u.display_name, u.show_links FROM site.users u WHERE u.matrix_id = $1`, [matrixKey]);
      owner = rows[0] ?? null;
    } else if (canonical) {
      const { rows } = await pool.query<LinkOwner>(LINK_OWNER_SQL, [canonical, self]);
      owner = rows[0] ?? null;
    }
    const { rows } = await pool.query<{ all_show: boolean | null }>(IDENTITY_SPAN_SQL, [canonical, matrixKey]);
    if (owner) owner = { ...owner, show_links: owner.show_links && rows[0]?.all_show === true };
    return { owner };
  } catch {
    return { owner: null };
  }
}
