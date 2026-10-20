// web/app/lib/playerPanelClass.test.ts
// The fold must animate from the height on screen — a partly open panel must
// not warp to full first and then fold. The panel keeps its MODE class while
// folding; dropping it would resize the box before the collapse.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/playerPanelClass.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { playerPanelClass } from "./playerPanelClass.ts";

test("open: exactly one mode class", () => {
  assert.equal(playerPanelClass({ folded: false, fallbackClass: "player-radio", fillMode: false }), "player-radio");
  assert.equal(playerPanelClass({ folded: false, fallbackClass: null, fillMode: true }), "player-fill md:flex-1 md:min-h-0");
  assert.equal(playerPanelClass({ folded: false, fallbackClass: null, fillMode: false }), "player-attached");
});

test("folded: the mode class STAYS, player-folded is added", () => {
  assert.equal(playerPanelClass({ folded: true, fallbackClass: "player-radio", fillMode: false }), "player-radio player-folded");
  assert.equal(playerPanelClass({ folded: true, fallbackClass: null, fillMode: false }), "player-attached player-folded");
  assert.equal(playerPanelClass({ folded: true, fallbackClass: null, fillMode: true }), "player-fill md:flex-1 md:min-h-0 player-folded");
});
