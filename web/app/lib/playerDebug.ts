// The player's debug log — what the player and the page around it did, in order, so a "it paused
// (or reloaded) by itself" report comes with the sequence that led to it.
//
// OFF unless switched on, per device: open the site once with `?playerdebug=1` (it stays on across
// reloads, which matters because a reload is one of the things being chased); `?playerdebug=0`
// switches it off. Same URL-switch idiom as `?kbdebug`.
//
// While on, every pause, mute change, media reset (`emptied`), embed reload and player remount sends
// ONE row to the client-error sink (source "player", so it rides the player's own budget in
// clientError.ts) carrying the last events before it — and the time since the viewer's last tap or
// key, which is what separates "I paused it" from "it paused itself". The log is also readable in
// the console as `window.__playerDebug`.
//
// Pure: no DOM here, so the switch, the buffer and the report shape are unit-tested
// (playerDebug.test.ts); usePlayerDebug.ts wires it to the page.

/** localStorage key for the per-device switch. */
export const PLAYER_DEBUG_KEY = "player_debug";

/** The switch: the URL wins and is remembered; otherwise the remembered value.
 *  `store` is what to write back: "1" to remember on, null to forget, undefined to leave alone. */
export function readPlayerDebugSwitch(search: string, stored: string | null): { on: boolean; store: "1" | null | undefined } {
  const m = /[?&]playerdebug=([^&]*)/.exec(search);
  if (m) {
    const on = m[1] !== "0" && m[1] !== "false" && m[1] !== "off";
    return { on, store: on ? "1" : null };
  }
  return { on: stored === "1", store: undefined };
}

/** Events that send a report when they happen (the rest only fill the log). */
const REPORTED = new Set(["pause", "muted", "emptied", "iframe-reload", "remount"]);

type DebugEntry = { t: number; kind: string; detail: string };

const MAX_STACK_CHARS = 3800; // the sink keeps 4000

export class PlayerDebugLog {
  private entries: DebugEntry[] = [];
  private lastInteraction = -Infinity;
  private readonly start: number;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(cap = 40, now: () => number = () => Date.now()) {
    this.cap = cap;
    this.now = now;
    this.start = now();
  }

  /** A tap, click or key press anywhere on the page. */
  interaction(): void { this.lastInteraction = this.now(); }

  /** Record an event. Returns a report to send when this event is one that should be reported. */
  push(kind: string, detail = ""): { message: string; stack: string } | null {
    const t = this.now();
    this.entries.push({ t: t - this.start, kind, detail: detail.slice(0, 120) });
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    if (!REPORTED.has(kind)) return null;
    const sinceTap = Number.isFinite(this.lastInteraction) ? Math.round(t - this.lastInteraction) : null;
    // The time is in the message on purpose: the sink drops a repeat of the same message within
    // 30 s, and two pauses a minute apart are two events.
    const message = `player debug: ${kind}${detail ? ` (${detail.slice(0, 60)})` : ""} at +${Math.round((t - this.start) / 1000)}s, ` +
      (sinceTap === null ? "no tap or key this load" : `last tap or key ${sinceTap} ms before`);
    return { message, stack: this.format() };
  }

  /** The log as text, newest last, cut from the OLDEST end to fit the sink. */
  format(): string {
    const lines = this.entries.map((e) => `+${(e.t / 1000).toFixed(1)}s ${e.kind}${e.detail ? ` ${e.detail}` : ""}`);
    let out = lines.join("\n");
    while (out.length > MAX_STACK_CHARS && lines.length > 1) { lines.shift(); out = lines.join("\n"); }
    return out;
  }
}
