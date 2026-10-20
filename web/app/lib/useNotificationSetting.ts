"use client";

// The current notification setting for one room, and the writes that change it.
//
// The client is passed IN rather than pulled from context: this file sits in
// app/lib, and matrixIdentity.test.ts fails any module outside features/community
// that reaches for the whole Matrix client.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  roomNotifySetting, accountNotificationsOff, ruleOpsFor,
  type NotifySetting, type RuleSet,
} from "./pushRules.ts";

export type PushClient = {
  pushRules?: RuleSet;
  addPushRule(scope: string, kind: string, ruleId: string, body: object): Promise<unknown>;
  deletePushRule(scope: string, kind: string, ruleId: string): Promise<unknown>;
  setPushRuleEnabled(scope: string, kind: string, ruleId: string, enabled: boolean): Promise<unknown>;
  on(ev: string, fn: () => void): void;
  off(ev: string, fn: () => void): void;
};

// The account-data event name the SDK emits (ClientEvent.AccountData). A string
// literal rather than the enum so this module imports no SDK value — it must
// stay loadable under `node --test`.
const ACCOUNT_DATA = "accountData";

export function useNotificationSetting(client: PushClient | null | undefined, roomId: string) {
  const fromServer = roomNotifySetting(client?.pushRules, roomId);
  const [optimistic, setOptimistic] = useState<NotifySetting | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  // Two clicks in quick succession must never both be in flight: choose()
  // snapshots client.pushRules synchronously, so a second write started before
  // the first round-trips can miss the rule the first just added and leave a
  // room carrying both a mute override AND a room rule at once — the exact
  // state pushRules.ts's header says must never happen. A plain ref (not
  // state) because it must be readable synchronously at click time, the same
  // pattern PresenceStatusPicker uses for its own save(). The second click is
  // ignored outright rather than queued: simpler to reason about, and the
  // ignored click can just be clicked again once the first settles.
  const inFlight = useRef(false);
  // Set true the instant a write's own requests all resolve — BEFORE the
  // server's account-data echo of that write has necessarily arrived. It is
  // what lets the reconcile effect below tell "the write is still running,
  // wait" from "the write finished and the server's answer still disagrees" —
  // without it, disagreement had no way to ever resolve (defect #5): nothing
  // cleared `optimistic` when `fromServer` simply never caught up, so a stale
  // tick could sit on screen forever with no error and no revert.
  const writeSettled = useRef(false);
  // Consecutive reconcile runs, since the write settled, where the server's
  // answer disagreed with no AGREEING run in between. `ruleOpsFor` deletes
  // THEN adds for a mute-clearing transition (e.g. "none" -> "mentions"), and
  // those are two separate rule changes the server can echo as two separate
  // account-data events — the first echo alone can reflect the intermediate
  // state (the delete landed, the add has not), which disagrees with
  // `optimistic` without the write having actually failed. Reverting on that
  // one echo flashed a "Try again" alert beside a setting that was, a beat
  // later, correct (re-review defect #2). Only a SECOND consecutive
  // disagreement counts as the server's real answer.
  const disagreeStreak = useRef(0);

  // A change made in Element arrives as m.push_rules account data; re-read.
  useEffect(() => {
    if (!client) return;
    const onData = () => setTick((t) => t + 1);
    client.on(ACCOUNT_DATA, onData);
    return () => client.off(ACCOUNT_DATA, onData);
  }, [client]);

  // Reconcile the optimistic value against the server's answer. This does NOT
  // run only on a fresh account-data tick: `fromServer` is recomputed fresh
  // from `client.pushRules` on every render (it is not memoized), so ANY
  // re-render that leaves a different value in its dependency slot re-runs
  // this effect too, tick or no tick — e.g. if the SDK had already mutated its
  // local pushRules cache in place before some unrelated re-render ran. The
  // revert itself is pushed to a microtask rather than called synchronously in
  // the effect body — react-hooks/set-state-in-effect (a hard error here)
  // flags a same-tick setState in an effect as a cascading-render risk; a
  // microtask still lands well before the next paint, so there is no visible
  // delay either way.
  useEffect(() => {
    if (optimistic === null) return;
    if (optimistic === fromServer) {
      // The server agrees — stop overriding.
      disagreeStreak.current = 0;
      void Promise.resolve().then(() => setOptimistic(null));
      return;
    }
    // Still disagreeing. Only a real problem once OUR write has actually
    // finished — reconciling mid-write would revert a value the write hasn't
    // even landed yet — AND the disagreement has survived a second
    // consecutive run with nothing agreeing in between (see disagreeStreak
    // above).
    if (!writeSettled.current) return;
    disagreeStreak.current += 1;
    if (disagreeStreak.current < 2) return;
    disagreeStreak.current = 0;
    writeSettled.current = false;
    void Promise.resolve().then(() => {
      setOptimistic(null);
      setError(true);
    });
  }, [optimistic, fromServer, tick]);

  const choose = useCallback(
    (next: NotifySetting) => {
      if (!client) return;
      if (inFlight.current) return; // a write is already running — ignore, don't interleave
      inFlight.current = true;
      writeSettled.current = false;
      disagreeStreak.current = 0;
      setOptimistic(next);
      setError(false);
      const ops = ruleOpsFor(next, roomId, client.pushRules);
      void (async () => {
        try {
          for (const op of ops) {
            if (op.op === "delete") await client.deletePushRule("global", op.kind, op.ruleId);
            else await client.addPushRule("global", op.kind, op.ruleId, op.body);
          }
          writeSettled.current = true;
        } catch {
          setOptimistic(null);
          setError(true);
        } finally {
          inFlight.current = false;
        }
      })();
    },
    [client, roomId]
  );

  const turnAccountOn = useCallback(() => {
    if (!client) return;
    setError(false);
    void client
      .setPushRuleEnabled("global", "override", ".m.rule.master", false)
      .then(() => setTick((t) => t + 1))
      .catch(() => setError(true));
  }, [client]);

  return {
    setting: optimistic ?? fromServer,
    accountOff: accountNotificationsOff(client?.pushRules),
    error,
    choose,
    turnAccountOn,
  };
}
