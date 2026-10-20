import type { MatrixEvent } from "matrix-js-sdk";

// One aggregated reaction key on a message: the emoji/key, how many people used
// it, — if I'm one of them — the id of *my* reaction event (so a second tap can
// redact it to toggle off), and the image to draw when the key is a Discord
// custom emoji (null for unicode and for our own emote shortcodes).
export type ReactionAgg = { key: string; count: number; mine: string | null; mxc: string | null };

/** What a tap on a custom-emoji pile sends so the bridge can relay it. */
export type ReactionExtra = { mxc: string; shortcode: string };

// targetEventId → its aggregated reactions, sorted by count desc then key.
export type ReactionsMap = Map<string, ReactionAgg[]>;

export const EMPTY_REACTIONS: ReactionAgg[] = [];

const SHORTCODE = /^:[A-Za-z0-9_~-]+:$/;

// A bridged Discord custom-emoji reaction keys on ":NAME:" and carries the image
// in `fi.mau.discord.reaction.mxc`; a site user's tap on that pile keys on the
// mxc itself (the only key the bridge relays to Discord) and repeats the
// shortcode in `com.beeper.reaction.shortcode`. Both spellings are one pile.
function groupKeyAndImage(content: Record<string, unknown>, key: string): { group: string; mxc: string | null } {
  const shortcode = content["com.beeper.reaction.shortcode"];
  const group = typeof shortcode === "string" && SHORTCODE.test(shortcode) ? shortcode : key;
  const fromBridge = (content["fi.mau.discord.reaction"] as { mxc?: unknown } | undefined)?.mxc;
  const mxc =
    typeof fromBridge === "string" && fromBridge.startsWith("mxc://") ? fromBridge
    : key.startsWith("mxc://") ? key
    : null;
  return { group, mxc };
}

// Recompute reactions from the raw (unfiltered) timeline events. Reaction events
// (`m.reaction`, `m.annotation` rel) live in the same timeline as messages; we
// scan them rather than lean on the SDK relations container so a single pass also
// survives redactions (toggle-off) and late-decrypted reactions in E2EE rooms.
export function aggregateReactions(events: MatrixEvent[], myUserId: string): ReactionsMap {
  const byTarget = new Map<string, Map<string, { count: number; mine: string | null; mxc: string | null }>>();

  for (const ev of events) {
    if (ev.getType() !== "m.reaction" || ev.isRedacted()) continue;
    const content = ev.getContent() as Record<string, unknown>;
    const rel = content["m.relates_to"] as { rel_type?: string; event_id?: string; key?: string } | undefined;
    if (rel?.rel_type !== "m.annotation" || !rel.event_id || !rel.key) continue;

    const { group, mxc } = groupKeyAndImage(content, rel.key);
    let keys = byTarget.get(rel.event_id);
    if (!keys) { keys = new Map(); byTarget.set(rel.event_id, keys); }
    let agg = keys.get(group);
    if (!agg) { agg = { count: 0, mine: null, mxc: null }; keys.set(group, agg); }
    agg.count++;
    if (!agg.mxc && mxc) agg.mxc = mxc;
    if (ev.getSender() === myUserId) agg.mine = ev.getId() ?? null;
  }

  const out: ReactionsMap = new Map();
  for (const [targetId, keys] of byTarget) {
    out.set(
      targetId,
      [...keys.entries()]
        .map(([key, v]) => ({ key, count: v.count, mine: v.mine, mxc: v.mxc }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    );
  }
  return out;
}
