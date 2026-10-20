import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { getActiveTier } from "@/app/lib/entitlements";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";

// GET /api/chat/decrypt/<site.chat_messages id>
//
// The ONLY path by which the plaintext of an encrypted message leaves the
// server. Everything else in the pipeline — the WS broadcast, the 200-message
// history buffer stream-api replays on connect, the stream.chat_log mirror
// the bot reads, /api/chat/history — carries the scramble instead.
//
// This is NOT Matrix E2EE and must never be described as such in the UI. The
// server holds the plaintext; this route decides who may read it.

// Decrypting is a read per message, and a client legitimately fires several as
// a viewer taps down a backlog. Generous enough not to bite real use, tight
// enough that the endpoint cannot be walked to dump every encrypted message.
const isRateLimited = createSlidingWindowLimiter(10_000, 30);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad Request", { status: 400 });

  if (isRateLimited(matrixId)) {
    return Response.json({ error: "too_fast" }, { status: 429 });
  }

  // Who may read it:
  //   • an active site Supporter — the entitlement the feature is sold on. NOT
  //     a Twitch/YouTube sub: this reads site.subscriptions via getActiveTier,
  //     whose only writer is the billing webhook.
  //   • a mod or admin. The word blocklist already screens the plaintext at
  //     send time, but without this, mod chat-history and the automod queue
  //     would show only glyphs: an encrypted channel no moderator could
  //     review, and reports on it would be unactionable.
  //   • the AUTHOR, unconditionally. A sender whose subscription lapses must
  //     still be able to read their own words, and it costs nothing — they
  //     typed the message.
  type MsgRow = { encrypted_text: string | null; matrix_id: string; is_deleted: boolean };
  type ViewerRow = { is_mod: boolean; is_admin: boolean };
  const [tier, row, viewer] = await Promise.all([
    getActiveTier(matrixId),
    pool
      .query<MsgRow>(
        `SELECT encrypted_text, matrix_id, is_deleted FROM site.chat_messages WHERE id = $1`,
        [id]
      )
      .catch(() => ({ rows: [] as MsgRow[] })),
    // Fetched unconditionally rather than only when the subscription check
    // fails. Cheaper to reason about than to run: the first draft computed
    // `isMod` inside the not-a-subscriber branch, so a viewer who was BOTH a
    // subscriber and a mod read isMod === false and would have been refused
    // deleted messages — the one group most likely to be reading them.
    pool
      .query<ViewerRow>(`SELECT is_mod, is_admin FROM site.users WHERE matrix_id = $1`, [matrixId])
      .catch(() => ({ rows: [] as ViewerRow[] })),
  ]);

  const message = row.rows[0];
  const isMod = !!(viewer.rows[0]?.is_mod || viewer.rows[0]?.is_admin);
  // 404 for "no such message" AND for "that message is not encrypted" — the
  // difference is not the caller's business, and distinguishing them turns this
  // into an oracle for which message ids exist.
  if (!message || message.encrypted_text == null) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const isAuthor = message.matrix_id === matrixId;
  if (!isAuthor && !isMod && tier == null) {
    return Response.json({ error: "supporter_only" }, { status: 403 });
  }

  // A deleted message stays readable exactly to the people who can already see
  // deleted messages at all — the author and mods, who render them struck
  // through. For a plain subscriber it is gone, same as the text would be.
  if (message.is_deleted && !isAuthor && !isMod) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({ text: message.encrypted_text });
}
