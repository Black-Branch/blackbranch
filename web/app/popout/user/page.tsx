import { auth } from "@/auth";
import pool from "@/lib/db";
import UserCardPopout from "@/app/components/UserCardPopout";
import type { ChatMsg } from "@/app/lib/chatMsg";
import { NATIVE_PLATFORM, normalizePlatform } from "@/app/lib/nativePlatform";

async function isModUser(matrixId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT is_mod, is_admin FROM site.users WHERE matrix_id = $1`,
      [matrixId]
    );
    return !!(rows[0]?.is_mod || rows[0]?.is_admin);
  } catch {
    return false;
  }
}

/**
 * The user card in its own window.
 *
 * Mod status is resolved from the SESSION here, never from the query string —
 * the URL is fully attacker-controlled (anyone can type one), so trusting an
 * `isMod` param would hand the mod UI to any visitor. The rendered controls are
 * cosmetic anyway: every mod route re-checks with requireMod/requireAdmin
 * server-side. This just avoids showing buttons that would 403.
 */
export default async function UserCardPopoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string): string | null => {
    const v = sp[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  const session = await auth();
  const isMod = session?.user?.id ? await isModUser(session.user.id) : false;

  // Synthetic message — identity is what matters; see UserCardPopout.
  const msg: ChatMsg = {
    id: one("mid") ?? "",
    platform: String(normalizePlatform(one("platform") ?? NATIVE_PLATFORM)),
    username: one("username") ?? "",
    message: "",
    // 0, not Date.now(): this synthetic message is never rendered as a chat row
    // (the history list is built from the live socket, which never contains it),
    // so the timestamp is unused — and reading the clock during render is impure.
    ts: 0,
    matrixId: one("matrixId"),
    publicId: one("publicId"),
    avatarUrl: one("avatarUrl"),
    // Badge flags are display-only and NOT carried in the URL on purpose: they
    // would be self-asserted by whoever opened the link. The card's real badges
    // come from the server lookup, which is authoritative.
    isMod: false,
    isVip: false,
    isMember: false,
  };

  return <UserCardPopout isMod={isMod} msg={msg} />;
}
