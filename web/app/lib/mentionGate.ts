// Behavior › mention sound: decides WHEN it may play. The sound itself is
// mentionSound.ts; this is the pure part so node --test can drive it with a clock.
//
// Plays for a row that (a) is flagged `alert` (mentions/replies to the viewer),
// (b) arrived as a LIVE frame (`live` — useChatMessages marks WebSocket messages
// `_anim`; the initial load, scroll-back and the reconnect replay never are), and
// (c) was not in the list the last time we looked. At most one sound every 2 s,
// so a pile-on is one ping, not ten.
//
// No timestamp test. The message time is the SERVER's and the viewer's clock
// can be minutes off: a fast phone would never ping, a slow one would ping for
// replayed history. `live` is the signal that means "new".
//
// PURE and import-free: node --test imports it directly.

/** `key` is chatKey (platform:id) — ids alone collide across platforms. */
export type GateRow = { key: string; live: boolean; alert: boolean };

const MIN_GAP_MS = 2_000;

export function createMentionGate(now: () => number = Date.now) {
  let seen = new Set<string>();
  let lastPlay = -Infinity;
  return {
    /** Look at the current rows; true when a sound should play now. */
    check(rows: readonly GateRow[]): boolean {
      let hit = false;
      const next = new Set<string>();
      for (const r of rows) {
        next.add(r.key);
        if (r.alert && r.live && !seen.has(r.key)) hit = true;
      }
      seen = next;
      const t = now();
      if (!hit || t - lastPlay < MIN_GAP_MS) return false;
      lastPlay = t;
      return true;
    },
  };
}
