// The Matrix client's boot clock: what the running readiness stage says while it runs.
//
// One clock PER STAGE, restarted whenever a stage starts. A slow stage gets a note ("Still
// connecting… 12 s"), never an error: on a slow phone network the encryption engine's download alone
// takes ~40 s, and calling that "failed" put a Try again in front of a person whose boot was working
// (and the restart it offered went back to the start of the same wait). Only the session check —
// one small request to the site — is failed by time, after a minute with no answer. A clock cannot
// tell a slow download from a stuck one (the same 2 MB engine took 42 s and 102 s on two runs), and
// the browser ends a failed download with an error each stage already handles. The first /sync is
// the SDK's own request, with its own timeout and retries; the SDK reports its trouble (ERROR /
// RECONNECTING), which shows as "still trying".
// Once the first sync has arrived nothing here speaks again; the reconnect pill (syncHealth.ts)
// owns connection trouble from then on.
//
// Pure and clock-free (the caller passes `at` / `now`), so it is node-tested as a state machine.

export type BootStageId = "token" | "sdk" | "crypto" | "sync";

/** A stage is quiet for this long before it says anything (a normal boot never shows a note).
 *  @test-only exported so the state-machine tests state the thresholds instead of copying them */
export const NOTE_AFTER_MS = 5_000;
/** The session check with no answer for this long is failed, with Try again.
 *  @test-only exported so the state-machine tests state the thresholds instead of copying them */
export const STALL_AFTER_MS = 60_000;

export type BootWatch = {
  readonly stage: BootStageId | null;
  readonly since: number;
  /** The SDK has reported a failed request since the sync stage started (and none has succeeded). */
  readonly trouble: boolean;
  /** The first PREPARED/SYNCING has arrived: the boot is over for this run. */
  readonly prepared: boolean;
};

export type BootEvent =
  | { type: "enter"; stage: BootStageId; at: number }
  /** A matrix-js-sdk SyncState string, as the client's Sync event reports it. */
  | { type: "sync"; state: string };

export type BootSay =
  | { kind: "quiet" }
  | { kind: "note"; text: string }
  | { kind: "stall"; text: string };

export function bootWatchStart(): BootWatch {
  return { stage: null, since: 0, trouble: false, prepared: false };
}

export function bootWatchStep(w: BootWatch, ev: BootEvent): BootWatch {
  if (ev.type === "enter") return { ...w, stage: ev.stage, since: ev.at, trouble: false };
  if (ev.state === "PREPARED" || ev.state === "SYNCING") return { ...w, prepared: true, trouble: false };
  if (ev.state === "ERROR" || ev.state === "RECONNECTING") return { ...w, trouble: true };
  return { ...w, trouble: false };
}

export function bootWatchSay(w: BootWatch, now: number): BootSay {
  if (w.prepared || !w.stage) return { kind: "quiet" };
  const ran = now - w.since;
  if (ran < NOTE_AFTER_MS) return { kind: "quiet" };
  if (w.stage === "token" && ran >= STALL_AFTER_MS) return { kind: "stall", text: "No answer after a minute" };
  const secs = Math.floor(ran / 1000);
  if (w.stage === "sync" && w.trouble) return { kind: "note", text: `Can't reach the server yet, still trying… ${secs} s` };
  return { kind: "note", text: `Still connecting… ${secs} s` };
}
