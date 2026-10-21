// The DM nudge's mailbox: "someone just sent you a direct message", held on the web server for the
// recipient alone. SERVER ONLY (used by app/api/dm/ping).
//
// POST /api/dm/ping records a nudge here; the recipient's own signed-in page asks GET /api/dm/ping
// for the newest stamp and, on a new one, starts its Matrix client and looks for what arrived. The
// nudge never goes out on the PUBLIC chat socket: a stable per-recipient tag there would let anyone
// who nudged a chosen person once recognise every later nudge to them.
// Kept here, a nudge is visible only to the session it is for.
//
// One stamp per recipient (the newest), strictly rising so two nudges in one millisecond still
// read as new; gone after NUDGE_TTL_MS; at most `cap` recipients held. In memory: a restart drops
// pending nudges, which only means the recipient sees the DM when they next open messages.

/** @test-only exported so the tests can step a fake clock past exactly this boundary. */
export const NUDGE_TTL_MS = 10 * 60_000;
const CAP = 10_000;

/** A mailbox with its own clock and cap.
 *  @test-only exported so the tests drive a fake clock and a small cap; `dmNudges` below is its caller. */
export function createNudgeBox(now: () => number = Date.now, cap = CAP) {
  // recipient → newest stamp and when it was recorded; Map order = oldest record first
  const box = new Map<string, { stamp: number; at: number }>();
  return {
    record(to: string): void {
      const at = now();
      const stamp = Math.max(at, (box.get(to)?.stamp ?? 0) + 1);
      box.delete(to); // re-insert at the end: the Map stays ordered oldest → newest
      box.set(to, { stamp, at });
      for (const [who, e] of box) {
        if (box.size <= cap && at - e.at <= NUDGE_TTL_MS) break;
        box.delete(who);
      }
    },
    /** The newest pending stamp for `me`, or 0 when there is none. */
    latest(me: string): number {
      const e = box.get(me);
      return e && now() - e.at <= NUDGE_TTL_MS ? e.stamp : 0;
    },
    size: () => box.size,
  };
}

const g = globalThis as unknown as { __dmNudges?: ReturnType<typeof createNudgeBox> };
/** The process's one mailbox (the web server is a single process). */
export const dmNudges = (g.__dmNudges ??= createNudgeBox());
