// One chat on screen, never two: the slot a console's chat view raises while it has the window,
// and the hook the chat lists read. How this install's terminal uses it is tested in its owner
// folder.
//
// Run: node --test app/lib/chatTakeover.test.ts
import test from "node:test";
import assert from "node:assert/strict";

const { setChatTakeover, chatTakenOver, onChatTakeover } = await import("./chatTakeover.ts");


test("the slot: raised by the TUI, heard by whoever listens, cleared after", () => {
  setChatTakeover(false);
  const seen: boolean[] = [];
  const off = onChatTakeover(() => seen.push(chatTakenOver()));
  setChatTakeover(true);
  assert.equal(chatTakenOver(), true);
  setChatTakeover(true);
  setChatTakeover(false);
  assert.deepEqual(seen, [true, false], "a change is announced once; the same value again is not");
  off();
  setChatTakeover(true);
  assert.deepEqual(seen, [true, false], "unsubscribed");
  setChatTakeover(false);
});
