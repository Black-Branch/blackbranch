// Your name colour, set from anywhere: Edit profile's colour picker and the terminal's profile file
// go through this ONE function. Your name changes on the page at once (the picker's own local store
// and refresh event); the save to your account is coalesced — half a second after the last change,
// never more than one every five seconds, the newest colour wins — so a script that sets a colour on
// every message cannot hammer the server. A save still waiting when the page goes is sent on the way
// out (keepalive).
import { lsRemove, lsSet } from "./safeLocalStorage";
import { invalidateProfileCard } from "./profileCardPrefetch";

/** Quiet this long after the last change before saving. */
const SETTLE_MS = 500;
/** At most one save this often. */
const GAP_MS = 5000;

type Timer = ReturnType<typeof setTimeout>;
type Deps = {
  /** Show it on this page now. */
  local: (hex: string | null) => void;
  /** Save it to the account; `keepalive` on the way out. True when it took. */
  save: (hex: string | null, keepalive: boolean) => Promise<boolean>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (t: Timer) => void;
};

/** The coalescer over its I/O.
 *  @test-only exported so ownColor.test.ts can drive it on a fake clock; `setOwnColor` below is its one production use. */
export function colorSaver(d: Deps) {
  let pending: { hex: string | null } | null = null;
  let timer: Timer | null = null;
  let lastSave = -Infinity;
  let waiters: (() => void)[] = [];
  const run = async () => {
    timer = null;
    if (!pending) return;
    const { hex } = pending;
    pending = null;
    lastSave = d.now();
    const done = waiters;
    waiters = [];
    await d.save(hex, false).catch(() => false);
    for (const w of done) w();
    if (pending) schedule();
  };
  const schedule = () => {
    if (timer) d.clearTimer(timer);
    timer = d.setTimer(() => void run(), Math.max(SETTLE_MS, lastSave + GAP_MS - d.now()));
  };
  return {
    /** Show `hex` now and save it soon; resolves once a save carrying it (or a newer one) has landed. */
    set(hex: string | null): Promise<void> {
      d.local(hex);
      pending = { hex };
      schedule();
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
    /** The page is going: send what waits, now. */
    flush(): void {
      if (!pending) return;
      if (timer) { d.clearTimer(timer); timer = null; }
      const { hex } = pending;
      pending = null;
      lastSave = d.now();
      const done = waiters;
      waiters = [];
      void d.save(hex, true).catch(() => false).then(() => { for (const w of done) w(); });
    },
  };
}

let shared: ReturnType<typeof colorSaver> | null = null;
function saver() {
  if (shared) return shared;
  shared = colorSaver({
    local: (hex) => {
      if (hex) lsSet("chatUsernameColor", hex); else lsRemove("chatUsernameColor");
      // The same-tab refresh the picker has always sent: every reader of the key re-reads it.
      window.dispatchEvent(new window.Event("storage"));
    },
    save: async (hex, keepalive) => {
      try {
        const r = await fetch("/api/me/color", hex
          ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color: hex }), keepalive }
          : { method: "DELETE", keepalive });
        if (r.ok) invalidateProfileCard();
        return r.ok;
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  });
  const s = shared;
  window.addEventListener("pagehide", () => s.flush());
  return s;
}

/** Your name colour (`#rrggbb`, or null for the default): on the page now, saved to your account soon. */
export function setOwnColor(hex: string | null): Promise<void> {
  return saver().set(hex);
}
