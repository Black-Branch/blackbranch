import { auth } from "@/auth";
import pool from "@/lib/db";
import PopoutView from "@/app/components/PopoutView";
import { latestChatHistory } from "@/app/api/chat/history/route";
import { CHAT_LIVE_CAP } from "@/app/lib/chatCaps";
import { manifestWithin } from "@/app/api/emotes/route";
import { emotesUsedBy } from "@/app/lib/emoteSubset";
import { preferredCanonical } from "@/app/lib/canonicalFromMatrix";

async function getUserMeta(matrixId: string) {
  try {
    const { rows } = await pool.query(
      `SELECT is_mod, is_admin FROM site.users WHERE matrix_id = $1`,
      [matrixId]
    );
    return rows[0] ?? { is_mod: false, is_admin: false };
  } catch {
    return { is_mod: false, is_admin: false };
  }
}

// The viewer's ONE preferred canonical (a display read: their own stats), by the one tie-break.
const viewerCanonical = (matrixId: string) => preferredCanonical(matrixId, (sql, params) => pool.query(sql, params));

export default async function PopoutPage() {
  const session = await auth();
  const [userMeta, canonicalId] = session?.user?.id
    ? await Promise.all([getUserMeta(session.user.id), viewerCanonical(session.user.id)])
    : [{ is_mod: false, is_admin: false }, null];
  const isMod = userMeta.is_mod || userMeta.is_admin;
  // The newest page of chat history, so the popout opens with its rows in the
  // HTML (chatHistorySeed.test.ts). A failure costs the seed, never the page.
  const messages = await latestChatHistory({ me: session?.user?.id ?? null, isMod }, CHAT_LIVE_CAP)
    .catch(() => []);
  // The emotes those rows use, so they render as <img>s in the HTML (emoteSubset.ts).
  const initialEmotes = emotesUsedBy(messages.map((m) => m.message), await manifestWithin().catch(() => ({})));

  return (
    <PopoutView
      isSignedIn={!!session?.user}
      userId={session?.user?.id ?? null}
      canonicalId={canonicalId}
      isMod={isMod}
      isAdmin={userMeta.is_admin}
      initialMessages={messages}
      initialEmotes={initialEmotes}
    />
  );
}
