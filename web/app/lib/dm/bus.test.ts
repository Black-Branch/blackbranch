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

test("the on-screen room: set/clear, and an older timeline's release does not clear a newer one", async () => {
  const { roomOnScreen, setRoomOnScreen } = await import("./bus.ts");
  assert.equal(roomOnScreen(), null, "nothing registered");
  let shown = true;
  const releaseA = setRoomOnScreen("!a", () => shown);
  assert.equal(roomOnScreen(), "!a");
  shown = false;
  assert.equal(roomOnScreen(), null, "registered but not shown right now (another pane, a hidden tab)");
  shown = true;
  const releaseB = setRoomOnScreen("!b");
  releaseA();
  assert.equal(roomOnScreen(), "!b", "the earlier timeline's cleanup does not clear the newer one");
  releaseB();
  assert.equal(roomOnScreen(), null);
  setRoomOnScreen("!c");
  setRoomOnScreen(null);
  assert.equal(roomOnScreen(), null, "null clears");
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

// "Open in Community": the DM window parks the room and signals; the chat column switches to the
// Matrix tab and the Community view takes the room — on the signal, or when it mounts after it.
test("takeOpenRoom returns the parked id once", async () => {
  const { requestOpenRoom, takeOpenRoom, onOpenRoomRequest } = await import("./bus.ts");
  assert.equal(takeOpenRoom(), null, "nothing parked");
  const heard: string[] = [];
  const off = onOpenRoomRequest((id) => heard.push(id));
  requestOpenRoom("!dm:site.test");
  assert.deepEqual(heard, ["!dm:site.test"], "the listener hears the room");
  assert.equal(takeOpenRoom(), "!dm:site.test");
  assert.equal(takeOpenRoom(), null, "taken once: a second view mounting later opens nothing");
  off();
});

test("restart: a Community view that mounts AFTER the signal still opens the room (nobody was listening)", async () => {
  const { requestOpenRoom, takeOpenRoom } = await import("./bus.ts");
  requestOpenRoom("!late:site.test");
  assert.equal(takeOpenRoom(), "!late:site.test", "parked until the view mounts and takes it");
});

test("retry: a second press before the first was taken opens the newest room, once", async () => {
  const { requestOpenRoom, takeOpenRoom } = await import("./bus.ts");
  requestOpenRoom("!a:site.test");
  requestOpenRoom("!b:site.test");
  assert.equal(takeOpenRoom(), "!b:site.test");
  assert.equal(takeOpenRoom(), null);
  requestOpenRoom("!a:site.test");
  assert.equal(takeOpenRoom(), "!a:site.test", "a press after the take parks again");
});
