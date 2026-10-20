// Writing blocklist hits into the review queue.
//
// A blocklist hit is recorded, not just rejected, so the operator can answer
// the question that actually matters — WHO keeps trying, and does this person
// need moderation, maybe a ban?
//
// Rows land in the same `site.automod_held` the Twitch queue uses, so the
// inline chat bar surfaces both without a second UI.
//
// Deny does NOT punish. A review row is a decision about the MESSAGE; ban and
// timeout stay separate buttons a mod presses deliberately. This
// module therefore never touches site.bans.

import pool from "@/lib/db";
import type { Verdict } from "./blacklist";
import { NATIVE_PLATFORM } from "@/app/lib/nativePlatform";

/**
 * Record a BLOCKED (severity-4) hit for review. Never throws. A hold uses
 * holdBlocklistHit, which the sender's pending line needs the row id from.
 *
 * FIRE-AND-FORGET by design — call it with `void`, do not await. The sender is
 * getting a rejection either way, and making them wait on a write that only
 * exists for the moderator's benefit is needless sluggishness. A lost row on a
 * DB blip costs one review entry; a blocked message is still blocked, because
 * the block decision is made in memory by `classify`.
 */
/**
 * The display name is resolved HERE, not passed in. The callers run their
 * checks before fetching the user row — deliberately, so a refused message
 * does no database work first. Both recorders are off the response path, so
 * the extra SELECT costs the sender nothing and the review row still shows a
 * name instead of a bare matrix id.
 */
async function resolveDisplayName(matrixId: string | null): Promise<string | null> {
  if (!matrixId) return null;
  const { rows } = await pool
    .query<{ display_name: string | null }>(
      `SELECT display_name FROM site.users WHERE matrix_id = $1`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as { display_name: string | null }[] }));
  return rows[0]?.display_name ?? null;
}

export function recordBlocklistHit(args: {
  verdict: Extract<Verdict, { action: "hold" | "block" }>;
  text: string;
  matrixId: string | null;
  platform: string;
}): void {
  void insertBlocklistRow(args);
}

/**
 * A native word-filter HOLD: the same row as recordBlocklistHit, but awaited, because
 * the sender is told the row id to follow their message by (GET /api/chat/held/[id]).
 * Only a held message pays for the write — a
 * blocked or clean one never reaches here. Resolves null when the row could not be
 * written, which the caller must not report as "held".
 */
export function holdBlocklistHit(args: {
  verdict: Extract<Verdict, { action: "hold" | "block" }>;
  text: string;
  matrixId: string;
}): Promise<number | null> {
  return insertBlocklistRow({ ...args, platform: NATIVE_PLATFORM });
}

async function insertBlocklistRow(args: {
  verdict: Extract<Verdict, { action: "hold" | "block" }>;
  text: string;
  matrixId: string | null;
  platform: string;
}): Promise<number | null> {
  const { verdict, text, matrixId, platform } = args;
  // 'blocked' — never delivered, recorded so a mod can act on the person.
  // 'pending' — genuinely withheld, awaiting an allow/deny decision. A native
  // pending row IS releasable: the resolve route republishes it through
  // /chat/native on Allow (v89 — before that, Allow marked the row and the
  // message silently never appeared).
  const status = verdict.action === "block" ? "blocked" : "pending";
  const displayName = await resolveDisplayName(matrixId);
  return pool
    .query<{ id: number }>(
      `INSERT INTO site.automod_held
         (source, platform, matrix_id, user_name, text, category, level, matched_term, status)
       VALUES ('blocklist', $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        platform,
        matrixId,
        displayName,
        text,
        // `category` is the Twitch queue's "why" column — reusing it means the
        // existing bar renders a blocklist tag with no special-casing.
        verdict.tags[0] ?? "blocklist",
        verdict.severity,
        verdict.term,
        status,
      ]
    )
    .then((r) => Number(r.rows[0]?.id) || null)
    .catch((e) => {
      console.error("[blocklist] failed to record review row", e);
      return null;
    });
}

/**
 * A NATIVE message withheld by the link gate.
 *
 * Separate from recordBlocklistHit because of `source`, which the resolve
 * route dispatches on: 'link_gate' names the gate that held it, and carries
 * the reason + host in category/matched_term where a synthesized word-verdict
 * would have dropped them. Recording a link hold through recordBlocklistHit
 * would make Allow resolve the row without delivering.
 *
 * Flag-mode rows are 'flagged', never 'pending': the message was
 * DELIVERED, so the row is a measurement — a 'pending' one would grow an
 * Allow button that republishes the message a second time.
 */
export function recordLinkHit(args: {
  host: string;
  reason: string;
  text: string;
  matrixId: string | null;
  flagOnly: boolean;
}): void {
  void insertLinkRow(args);
}

/** A link-gate HOLD, awaited for its row id — see holdBlocklistHit. */
export function holdLinkHit(args: { host: string; reason: string; text: string; matrixId: string }): Promise<number | null> {
  return insertLinkRow({ ...args, flagOnly: false });
}

async function insertLinkRow(args: {
  host: string;
  reason: string;
  text: string;
  matrixId: string | null;
  flagOnly: boolean;
}): Promise<number | null> {
  const { host, reason, text, matrixId, flagOnly } = args;
  const displayName = await resolveDisplayName(matrixId);
  return pool
    .query<{ id: number }>(
      `INSERT INTO site.automod_held
         (source, platform, matrix_id, user_name, text, category, level, matched_term, status)
       VALUES ('link_gate', $7, $1, $2, $3, $4, 3, $5, $6)
       RETURNING id`,
      [
        matrixId,
        displayName,
        text,
        // The `:flag-only` suffix is kept alongside the status so the sizing
        // query can group on category alone.
        flagOnly ? `link:${reason}:flag-only` : `link:${reason}`,
        host,
        flagOnly ? "flagged" : "pending",
        NATIVE_PLATFORM,
      ]
    )
    .then((r) => Number(r.rows[0]?.id) || null)
    .catch(() => null /* best-effort, like the rest of this module */);
}
