// The community pane's boot clock (ticket #194): what the running stage says while it runs.
// Measured on the throwaway pair at 390 px on a slow 3G profile: the encryption engine's download
// alone took 42 s, and the old single 30 s timer marked "Preparing encryption" as failed while it
// was still downloading — "Try again" then restarted the boot onto the same timer. These pin the
// replacement: a clock per stage, a note (never an error) while a stage is slow, an error only for a
// stage with no progress for a minute, and nothing at all once the first sync has arrived.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bootWatchStart, bootWatchStep, bootWatchSay, NOTE_AFTER_MS, STALL_AFTER_MS, type BootWatch,
} from "./matrixBootWatch.ts";

const S = 1000;
function run(events: Parameters<typeof bootWatchStep>[1][]): BootWatch {
  return events.reduce(bootWatchStep, bootWatchStart());
}

test("a stage is quiet for its first seconds, then says how long it has been running — never an error while it may be progressing", () => {
  const w = run([{ type: "enter", stage: "crypto", at: 0 }]);
  assert.deepEqual(bootWatchSay(w, NOTE_AFTER_MS - 1), { kind: "quiet" });
  assert.deepEqual(bootWatchSay(w, 12 * S), { kind: "note", text: "Still connecting… 12 s" });
  assert.deepEqual(bootWatchSay(w, 42 * S), { kind: "note", text: "Still connecting… 42 s" }, "the 3G download at 42 s: a note, not 'failed'");
});

test("stage advance resets the timer: a stage entered late in the boot starts its own clock", () => {
  const w = run([
    { type: "enter", stage: "token", at: 0 },
    { type: "enter", stage: "sdk", at: 1 * S },
    { type: "enter", stage: "crypto", at: 2 * S },
    { type: "enter", stage: "sync", at: 55 * S },
  ]);
  assert.deepEqual(bootWatchSay(w, 56 * S), { kind: "quiet" }, "the boot is 56 s old but the sync stage is 1 s old");
  assert.deepEqual(bootWatchSay(w, 55 * S + NOTE_AFTER_MS), { kind: "note", text: "Still connecting… 5 s" });
});

test("only the session check stalls (a tiny request with no answer for a minute); downloads and the sync never fail by time", () => {
  const token = run([{ type: "enter", stage: "token", at: 0 }]);
  assert.equal(bootWatchSay(token, STALL_AFTER_MS - 1).kind, "note", "just under the ceiling");
  assert.deepEqual(bootWatchSay(token, STALL_AFTER_MS), { kind: "stall", text: "No answer after a minute" });
  // Measured on the pair at slow 3G: the encryption engine's 2 MB download took 42 s on one run and
  // 102 s on the next. A clock cannot tell that from a stuck stage; the browser ends a failed
  // download with an error the stage already handles.
  for (const stage of ["sdk", "crypto", "sync"] as const) {
    const w = run([{ type: "enter", stage, at: 0 }]);
    assert.deepEqual(bootWatchSay(w, 10 * 60 * S), { kind: "note", text: "Still connecting… 600 s" }, `${stage}: slow, never 'failed'`);
  }
});

test("a sync error before the first sync is 'still trying', and ERROR-then-SYNCING ends in ready", () => {
  let w = run([{ type: "enter", stage: "sync", at: 0 }, { type: "sync", state: "ERROR" }]);
  assert.deepEqual(bootWatchSay(w, 1 * S), { kind: "quiet" }, "a one-second blip shows nothing");
  assert.deepEqual(bootWatchSay(w, 8 * S), { kind: "note", text: "Can't reach the server yet, still trying… 8 s" });
  w = bootWatchStep(w, { type: "sync", state: "RECONNECTING" });
  assert.equal(bootWatchSay(w, 9 * S).kind, "note");
  w = bootWatchStep(w, { type: "sync", state: "CATCHUP" });
  assert.deepEqual(bootWatchSay(w, 10 * S), { kind: "note", text: "Still connecting… 10 s" }, "the connection is back: plain waiting again");
  w = bootWatchStep(w, { type: "sync", state: "SYNCING" });
  assert.equal(w.prepared, true);
  assert.deepEqual(bootWatchSay(w, 11 * S), { kind: "quiet" });
});

test("the error view is unreachable once PREPARED arrived", () => {
  let w = run([{ type: "enter", stage: "sync", at: 0 }, { type: "sync", state: "PREPARED" }]);
  for (const state of ["ERROR", "RECONNECTING", "STOPPED", "CATCHUP"]) {
    w = bootWatchStep(w, { type: "sync", state });
    for (const at of [1 * S, STALL_AFTER_MS, 10 * STALL_AFTER_MS]) {
      assert.deepEqual(bootWatchSay(w, at), { kind: "quiet" }, `${state} at ${at} ms after the first sync`);
    }
  }
  w = bootWatchStep(w, { type: "enter", stage: "crypto", at: 0 });
  assert.deepEqual(bootWatchSay(w, STALL_AFTER_MS), { kind: "quiet" }, "prepared is sticky for the run");
});

test("restart: a fresh watch (the retry's new run) starts from nothing, whatever the old one said", () => {
  const old = run([{ type: "enter", stage: "token", at: 0 }]);
  assert.equal(bootWatchSay(old, STALL_AFTER_MS).kind, "stall");
  const fresh = run([{ type: "enter", stage: "token", at: STALL_AFTER_MS }]);
  assert.deepEqual(bootWatchSay(fresh, STALL_AFTER_MS + 1), { kind: "quiet" });
  assert.equal(bootWatchStart().prepared, false);
  assert.equal(bootWatchStart().stage, null);
  assert.deepEqual(bootWatchSay(bootWatchStart(), STALL_AFTER_MS), { kind: "quiet" }, "nothing entered: nothing to say");
});
