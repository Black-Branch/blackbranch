// The DM window's signals: core writes, the feature listens.
// Run: node --test app/lib/dm/bus.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { onAnnouncement, onDmRequest, publishAnnouncement, registerDmHost, requestDm, type DmRequest } from "./bus.ts";

const casey = { matrixId: "@casey:site.test", username: "casey", displayName: "Casey" };

test("requestDm reaches the host while one is mounted, and says so when none is", () => {
  const got: DmRequest[] = [];
  const off = onDmRequest((r) => got.push(r));
  assert.equal(requestDm({ kind: "open", to: casey }), false, "no host mounted: the caller learns nothing opened");
  assert.equal(got.length, 0);
  const unmount = registerDmHost();
  assert.equal(requestDm({ kind: "open", to: casey, text: "hi" }), true);
  assert.deepEqual(got, [{ kind: "open", to: casey, text: "hi" }]);
  unmount();
  assert.equal(requestDm({ kind: "open", to: casey }), false, "after unmount there is nowhere to go again");
  off();
});

// DM nudges no longer travel the socket or this bus: the host asks for its own (nudgeBox.test.ts).
test("announcements go to every listener, and an unsubscribed one hears nothing", () => {
  const a: string[] = [];
  const offA = onAnnouncement((x) => a.push(x.text));
  publishAnnouncement({ id: "1", text: "stream in 5", by: "casey", at: 1 });
  offA();
  publishAnnouncement({ id: "2", text: "late", by: "", at: 2 });
  assert.deepEqual(a, ["stream in 5"]);
});
