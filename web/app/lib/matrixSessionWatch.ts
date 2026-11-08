// The refusal-rate alarm: one ops notify when sign-in refusals cluster. SERVER ONLY, pure (the clock
// and the notifier are injected — matrixSessionWatch.test.ts runs it).
//
// Why: on 2026-10-21 five accounts were signed out every 5 minutes for days (stale client columns →
// MAS "client id mismatch"), and the only signal was a viewer saying so. A refusal is now one
// journal line each (matrixSessionCore.ts); this turns a CLUSTER of them into one push. Thresholds
// (10-22 review §4.5): more than 3 refusals in an hour site-wide, or one account refused twice
// within an hour. One alarm per burst: after an alarm the same side stays quiet for one window,
// then re-arms — by TIME since that alarm, so a steady trickle cannot keep it latched.
//
// Two separate watches (createSessionAlarms): accounts on THIS install's server, and accounts on
// outside servers. An outside server's answers are not ours to trust — it, or anyone able to make
// its endpoints fail, could otherwise fire the local alarm at will, and while that alarm was
// latched a real local burst would be silent. Each watch has its own count, latch, wording and push
// key; both alarm at the SAME thresholds (the owner's rule above).
// The count lives in this process — a restart starts it empty; the journal keeps the record. No
// alarm names an account (the journal line has the device).

/** @test-only exported so the test pins the thresholds the 10-22 review set; only this module reads them. */
export const REFUSAL_WINDOW_MS = 60 * 60 * 1000;
/** @test-only exported so the test pins the thresholds the 10-22 review set; only this module reads them. */
export const REFUSAL_SITE_LIMIT = 3;
const ACCOUNT_LIMIT = 2;

export type RefusalWatch = {
  /** One refused refresh for `matrixId` (either verdict), or one re-sign-in whose old chain could
   *  not be revoked. */
  record(matrixId: string): void;
  /** @test-only entries held — the window must stay bounded. */
  size(): number;
};

type WatchText = { siteTitle: string; site: (n: number) => string; accountTitle: string; account: (n: number) => string };

const LOCAL_TEXT: WatchText = {
  siteTitle: "Sign-ins are being refused",
  site: (n) => `${n} sign-in refusals or failed revocations in the last hour. People may be signed out of the site. Journal: grep "[matrix-session]" in the web journal.`,
  accountTitle: "A sign-in keeps being refused",
  account: (n) => `In the last hour one account was refused ${n} times (a refused refresh or a failed revocation). Journal: grep "[matrix-session]" in the web journal.`,
};

const OUTSIDE_TEXT: WatchText = {
  siteTitle: "Outside servers refuse sign-ins",
  site: (n) => `${n} refusals or failed revocations from OUTSIDE servers in the last hour (not this install's). Journal: grep "[matrix-session].*path=federated".`,
  accountTitle: "An outside sign-in keeps being refused",
  account: (n) => `In the last hour one outside-server account was refused ${n} times. Journal: grep "[matrix-session].*path=federated".`,
};

/** One side's watch (count, latch, wording). The product builds two through createSessionAlarms.
 *  @test-only exported so the tests drive one side alone; the product reaches it only through createSessionAlarms. */
export function createRefusalWatch(deps: {
  now: () => number;
  notify: (title: string, message: string) => void;
  text?: WatchText;
}): RefusalWatch {
  const siteLimit = REFUSAL_SITE_LIMIT;
  const text = deps.text ?? LOCAL_TEXT;
  let events: { at: number; who: string }[] = [];
  let siteFiredAt: number | null = null;
  const accountFiredAt = new Map<string, number>();
  const armed = (firedAt: number | null | undefined, now: number) => firedAt == null || now - firedAt >= REFUSAL_WINDOW_MS;

  return {
    record(matrixId) {
      const now = deps.now();
      events = events.filter((e) => now - e.at < REFUSAL_WINDOW_MS);
      for (const [who, at] of accountFiredAt) if (armed(at, now)) accountFiredAt.delete(who);
      events.push({ at: now, who: matrixId });

      const mine = events.filter((e) => e.who === matrixId).length;
      if (events.length > siteLimit && armed(siteFiredAt, now)) {
        siteFiredAt = now;
        deps.notify(text.siteTitle, text.site(events.length));
      } else if (mine >= ACCOUNT_LIMIT && armed(accountFiredAt.get(matrixId), now)) {
        accountFiredAt.set(matrixId, now);
        if (armed(siteFiredAt, now)) deps.notify(text.accountTitle, text.account(mine));
      }
    },
    size: () => events.length,
  };
}

/** Which server the account lives on: this install's, or an outside one. */
export type AlarmSide = "local" | "federated";

export type SessionAlarms = {
  record(matrixId: string, side: AlarmSide): void;
  /** @test-only the two watches' held entries. */
  sizes(): { local: number; federated: number };
};

/**
 * The two watches behind one entry point: `local` pushes under `localKey`, `federated` (accounts
 * on outside servers) under `outsideKey`, each with its own count and latch, the same thresholds.
 */
export function createSessionAlarms(deps: {
  now: () => number;
  notify: (key: string, title: string, message: string) => void;
  localKey: string;
  outsideKey: string;
}): SessionAlarms {
  const local = createRefusalWatch({ now: deps.now, notify: (t, m) => deps.notify(deps.localKey, t, m) });
  const outside = createRefusalWatch({
    now: deps.now, notify: (t, m) => deps.notify(deps.outsideKey, t, m), text: OUTSIDE_TEXT,
  });
  return {
    record: (matrixId, side) => (side === "local" ? local : outside).record(matrixId),
    sizes: () => ({ local: local.size(), federated: outside.size() }),
  };
}
