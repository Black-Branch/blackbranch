// The notification menu: the tick follows the real rules, the account-wide
// switch is surfaced, a failed write reverts and says so.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/notificationMenu.render.test.ts

import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";
import type { RuleSet } from "./pushRules.ts";

installResizeObserverStub();
const { NotificationMenu } = await import("@/app/features/community/NotificationMenu");
const { createRoot } = await import("react-dom/client");

const ROOM_ID = "!general:site.test";

const PLAIN: RuleSet = {
  global: {
    override: [{ rule_id: ".m.rule.master", enabled: false, actions: ["dont_notify"] }],
    underride: [{ rule_id: ".m.rule.message", enabled: true, actions: ["notify"] }],
  },
};

function fakeClient(rules: RuleSet, opts: { failWrites?: boolean; captureAccountData?: boolean } = {}) {
  const calls: string[] = [];
  let onData: (() => void) | null = null;
  const box = { rules };
  return {
    calls,
    // Only meaningful with captureAccountData: fires the listener the menu's
    // hook registered, simulating the server's m.push_rules echo landing.
    fireAccountData: () => onData?.(),
    // Lets a test swap what the "server" now reports BEFORE the next
    // fireAccountData — simulating a multi-op write's intermediate state
    // landing before its final one.
    setRules: (next: RuleSet) => { box.rules = next; },
    client: {
      get pushRules() { return box.rules; },
      addPushRule: async (_s: string, kind: string, id: string) => {
        calls.push(`add:${kind}:${id}`);
        if (opts.failWrites) throw new Error("nope");
        return {};
      },
      deletePushRule: async (_s: string, kind: string, id: string) => { calls.push(`del:${kind}:${id}`); return {}; },
      setPushRuleEnabled: async (_s: string, _k: string, id: string, enabled: boolean) => {
        calls.push(`enable:${id}:${enabled}`);
        return {};
      },
      on: (_ev: string, fn: () => void) => { if (opts.captureAccountData) onData = fn; },
      off: () => { onData = null; },
    },
  };
}

/** A promise this test controls the settlement of, to pin down ordering that
 *  a same-tick-resolving fake can't: whether a value changed BEFORE or AFTER
 *  the write it's waiting on. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Like fakeClient, but the first addPushRule call PENDS on `gate` instead of
 *  resolving immediately — so a test can assert on state while that write is
 *  still outstanding, then let it complete. */
function fakeClientPending(rules: RuleSet) {
  const calls: string[] = [];
  const gate = deferred<void>();
  return {
    calls,
    gate,
    client: {
      pushRules: rules,
      addPushRule: async (_s: string, kind: string, id: string) => {
        calls.push(`add:${kind}:${id}`);
        await gate.promise;
        return {};
      },
      deletePushRule: async (_s: string, kind: string, id: string) => { calls.push(`del:${kind}:${id}`); return {}; },
      setPushRuleEnabled: async () => ({}),
      on: () => {}, off: () => {},
    },
  };
}

const fakeRoom = (roomId: string, name: string) => ({
  roomId, name,
  getUnreadNotificationCount: () => 0,
  getLiveTimeline: () => ({ getEvents: () => [] }),
});

async function render(
  client: unknown,
  serverRooms: unknown[] = [],
  extra: { onClose?: () => void; anchorRef?: { current: HTMLElement | null } } = {}
) {
  resetStorage();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(NotificationMenu, {
        room: fakeRoom(ROOM_ID, "general"), serverRooms, x: 10, y: 10,
        onClose: extra.onClose ?? (() => {}), client, anchorRef: extra.anchorRef,
      } as never)
    );
  });
  return { cleanup: () => act(async () => root.unmount()) };
}

const items = () => [...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[];
const item = (re: RegExp) => items().find((b) => re.test(b.textContent ?? "")) ?? null;

test("the current setting is the one marked checked", async () => {
  const { client } = fakeClient(PLAIN);
  const { cleanup } = await render(client);
  assert.equal(item(/All messages/)?.getAttribute("aria-checked"), "true");
  assert.equal(item(/Mentions only/)?.getAttribute("aria-checked"), "false");
  await cleanup();
});

test("a press on the anchor is not treated as outside — the toggle that opened the menu can close it, but a press on it never reopens it", async () => {
  // Defect #4: without the anchor, an outside-click fires on the bell's own
  // mousedown before its click handler runs, so the menu closes and the
  // click that follows reopens it — the bell could never close its own menu.
  // Threading `anchorRef` makes useOutsideClick treat the anchor as "inside",
  // so a press there fires neither onClose nor (since it's a plain external
  // element with no click handler of its own here) anything else.
  const { client } = fakeClient(PLAIN);
  const anchor = dom.window.document.createElement("button");
  dom.window.document.body.appendChild(anchor);
  let closes = 0;
  const { cleanup } = await render(client, [], { onClose: () => { closes += 1; }, anchorRef: { current: anchor } });
  await act(async () => {
    anchor.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  });
  assert.equal(closes, 0, "a press on the anchor must not be read as outside the menu");
  await cleanup();
});

test("without an anchor, a press anywhere else still closes the menu as before", async () => {
  const { client } = fakeClient(PLAIN);
  let closes = 0;
  const { cleanup } = await render(client, [], { onClose: () => { closes += 1; } });
  await act(async () => {
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  });
  assert.equal(closes, 1);
  await cleanup();
});

test("choosing Nothing writes an override rule", async () => {
  const { client, calls } = fakeClient(PLAIN);
  const { cleanup } = await render(client);
  await act(async () => { item(/Nothing/)!.click(); });
  assert.ok(calls.some((c) => c.startsWith("add:override:app.blackbranch.mute.")));
  await cleanup();
});

test("the tick moves immediately, before the server confirms", async () => {
  // addPushRule pends on `gate` — if this passed only because the fake
  // resolved in the same microtask flush, an implementation that set the
  // optimistic value AFTER awaiting the write would pass it too. Asserting
  // while the write is still outstanding is what rules that out.
  const { client, gate } = fakeClientPending(PLAIN);
  const { cleanup } = await render(client);
  await act(async () => { item(/Mentions only/)!.click(); });
  assert.equal(item(/Mentions only/)?.getAttribute("aria-checked"), "true", "must already read true while the write is pending");
  await act(async () => { gate.resolve(); });
  await cleanup();
});

test("two clicks in a row cannot interleave — the second is ignored while a write is in flight", async () => {
  const { client, calls, gate } = fakeClientPending(PLAIN);
  const { cleanup } = await render(client);
  await act(async () => {
    item(/Nothing/)!.click();
    item(/Mentions only/)!.click();
  });
  // Only the first choice's write may have been issued. If the second click
  // had gone through too, its "add:room:" op would show up here alongside
  // (or racing) the first — a room left with both a mute override AND a room
  // rule, the exact state pushRules.ts says can never happen.
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.startsWith("add:override:app.blackbranch.mute."));
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "true");
  assert.equal(item(/Mentions only/)?.getAttribute("aria-checked"), "false");
  await act(async () => { gate.resolve(); });
  await cleanup();
});

test("a failed write reverts the tick and says so out loud", async () => {
  const { client } = fakeClient(PLAIN, { failWrites: true });
  const { cleanup } = await render(client);
  await act(async () => { item(/Nothing/)!.click(); });
  assert.equal(item(/All messages/)?.getAttribute("aria-checked"), "true");
  const alert = dom.window.document.querySelector('[role="alert"]');
  assert.ok(alert, "a failed save must be announced, not silent");
  assert.match(alert?.textContent ?? "", /Try again/);
  await cleanup();
});

test("when a write RESOLVES but the server's answer PERSISTENTLY disagrees, the hook reverts and alerts — the same as an outright failed write (defect #5)", async () => {
  // pushRules never actually changes here — addPushRule/deletePushRule both
  // resolve (the write "succeeds"), but the fixture stands in for a server
  // that silently never adopted it. Before the fix, nothing ever cleared the
  // optimistic value once the two disagreed: the tick just stuck.
  const { client, fireAccountData } = fakeClient(PLAIN, { captureAccountData: true });
  const { cleanup } = await render(client);
  await act(async () => { item(/Nothing/)!.click(); });
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "true", "optimistic still shows while unsettled");
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null, "no alert yet — the write itself succeeded");
  // First echo of the (still-unchanged) rules: one disagreeing tick alone
  // must not revert (re-review defect #2) — see the debounce test below.
  await act(async () => { fireAccountData(); });
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "true", "one disagreeing echo alone must not revert yet");
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null, "and must not alert yet either");
  // A second echo, still disagreeing, with nothing agreeing in between.
  await act(async () => { fireAccountData(); });
  assert.equal(item(/All messages/)?.getAttribute("aria-checked"), "true", "must revert to the server's real answer");
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "false");
  const alert = dom.window.document.querySelector('[role="alert"]');
  assert.ok(alert, "a silent, persistent disagreement must be announced, the same as a failed write");
  assert.match(alert?.textContent ?? "", /Try again/);
  await cleanup();
});

test("an INTERMEDIATE echo of a two-op write (delete-then-add) is not mistaken for the server's final answer — no alert ever appears", async () => {
  // Re-review defect #2: ruleOpsFor's mute-clearing transitions issue a
  // DELETE then an ADD. A server that echoes each op as its own account-data
  // event can land the delete's echo before the add's — that intermediate
  // state legitimately disagrees with `optimistic` without the write having
  // failed. Reverting on it flashed a "Try again" beside a setting that was,
  // a beat later, correct.
  const START: RuleSet = {
    global: {
      ...PLAIN.global,
      room: [{ rule_id: ROOM_ID, enabled: true, actions: [] }], // starts on "mentions"
    },
  };
  const { client, fireAccountData, setRules } = fakeClient(START, { captureAccountData: true });
  const { cleanup } = await render(client);
  assert.equal(item(/Mentions only/)?.getAttribute("aria-checked"), "true");

  await act(async () => { item(/Nothing/)!.click(); }); // ruleOpsFor: delete room rule, then add a mute override
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "true", "optimistic shows immediately");

  // Intermediate echo: the delete landed, the add has not — no room rule AND
  // no mute override yet, which reads as "all" (the account default here),
  // disagreeing with the optimistic "none".
  await act(async () => {
    setRules({ global: { ...PLAIN.global, room: [], override: PLAIN.global!.override } });
    fireAccountData();
  });
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "true", "must not revert on the intermediate echo");
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null, "must not alert on it either");

  // Final echo: the add has now landed too.
  await act(async () => {
    setRules({
      global: {
        ...PLAIN.global,
        room: [],
        override: [
          ...(PLAIN.global!.override ?? []),
          {
            rule_id: "app.blackbranch.mute." + ROOM_ID, enabled: true, actions: [],
            conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM_ID }],
          },
        ],
      },
    });
    fireAccountData();
  });
  assert.equal(item(/Nothing/)?.getAttribute("aria-checked"), "true", "settles on the real, agreeing answer");
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null, "no alert ever appeared");
  await cleanup();
});

test("an account with notifications switched off is told, and can switch them on", async () => {
  const OFF: RuleSet = {
    global: {
      override: [{ rule_id: ".m.rule.master", enabled: true, actions: ["dont_notify"] }],
      underride: [{ rule_id: ".m.rule.message", enabled: true, actions: ["dont_notify"] }],
    },
  };
  const { client, calls } = fakeClient(OFF);
  const { cleanup } = await render(client);
  assert.match(dom.window.document.body.textContent ?? "", /off for your whole account/i);
  await act(async () => { item(/Turn (them )?on/i)!.click(); });
  assert.ok(calls.includes("enable:.m.rule.master:false"));
  await cleanup();
});

test("a normal account is never shown the account line", async () => {
  const { client } = fakeClient(PLAIN);
  const { cleanup } = await render(client);
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /whole account/i);
  await cleanup();
});

test("Mark all as read covers every channel in the server", async () => {
  const { client } = fakeClient(PLAIN);
  const marked: string[] = [];
  const withMarker = {
    ...client,
    setRoomReadMarkers: async (roomId: string) => { marked.push(roomId); return {}; },
  };
  const rooms = [fakeRoom("!a", "a"), fakeRoom("!b", "b")].map((r) => ({
    ...r,
    getUnreadNotificationCount: () => 3,
    getLiveTimeline: () => ({ getEvents: () => [{ getId: () => `$e-${r.roomId}`, status: null }] }),
  }));
  const { cleanup } = await render(withMarker, rooms);
  await act(async () => { item(/Mark all as read/)!.click(); });
  assert.deepEqual(marked.sort(), ["!a", "!b"]);
  await cleanup();
});
