import { test } from "node:test";
import assert from "node:assert/strict";
import { FACES, FACE_IDS, WINDOW_IDS, faceIdOf, faceOrDefault, isWindowId, windowsFor, defaultWindow, formatValue, isPeopleFace, faceLabel, windowLabel } from "./boardFaces.ts";

test("the ten faces in chip order", () => {
  assert.deepEqual(FACE_IDS, ["points", "credit", "creditRate", "streams", "wholesome", "toxic", "bigBrain", "smallBrain", "messages", "emotes"]);
  assert.deepEqual(FACES.map((f) => f.label), ["Earned points", "Karma", "Karma / 100", "Streams", "Wholesome", "Toxic", "Big brain", "Small brain", "Top messages", "Top emotes"]);
  assert.deepEqual(WINDOW_IDS, ["stream", "week", "month", "all"]);
  assert.equal(faceLabel("bigBrain"), "Big brain");
});

test("Streams offers no Stream window; every other face offers all four", () => {
  assert.deepEqual(windowsFor("streams"), ["week", "month", "all"]);
  for (const f of FACE_IDS) if (f !== "streams") assert.deepEqual(windowsFor(f), ["stream", "week", "month", "all"]);
});

test("window default: Stream while live, Week offline", () => {
  assert.equal(defaultWindow(true), "stream");
  assert.equal(defaultWindow(false), "week");
});

test("an unknown or missing stored face falls to credit; a window id is validated", () => {
  assert.equal(faceOrDefault(null), "credit");
  assert.equal(faceOrDefault("nope"), "credit");
  assert.equal(faceOrDefault("emotes"), "emotes");
  // The pre-rename "qorm" id is no longer mapped (R contract step): it falls to credit like any unknown.
  assert.equal(faceOrDefault("qorm"), "credit");
  assert.equal(faceIdOf("qorm"), null);
  assert.equal(faceIdOf("points"), "points");
  assert.equal(faceIdOf("nope"), null);
  assert.equal(faceIdOf(null), null);
  assert.equal(isWindowId("month"), true);
  assert.equal(isWindowId("year"), false);
  assert.equal(isWindowId(null), false);
});

test("values print in each face's format", () => {
  assert.equal(formatValue("points", 184), "184");
  assert.equal(formatValue("credit", 184), "+184");
  assert.equal(formatValue("credit", -3), "-3");
  assert.equal(formatValue("creditRate", 12.5), "+12.5");
  assert.equal(formatValue("creditRate", 12), "+12.0");
  assert.equal(formatValue("streams", 14), "14");
  for (const f of ["wholesome", "toxic", "bigBrain", "smallBrain"] as const) assert.equal(formatValue(f, 92), "92%");
  assert.equal(formatValue("messages", 41), "+41");
  assert.equal(formatValue("emotes", 412), "412");
});

test("people faces vs message/emote faces; window labels", () => {
  assert.equal(isPeopleFace("credit"), true);
  assert.equal(isPeopleFace("messages"), false);
  assert.equal(isPeopleFace("emotes"), false);
  assert.deepEqual(WINDOW_IDS.map(windowLabel), ["Stream", "Week", "Month", "All"]);
});

test("boardsWarm: every list present → warm; any cold (null) window → not warm; no boards at all → warm (nothing to wait for)", async () => {
  const { boardsWarm } = await import("./boardFaces.ts");
  const b = Object.fromEntries(FACE_IDS.map((f) => [f, Object.fromEntries(WINDOW_IDS.map((w) => [w, []]))])) as never as Record<string, Record<string, unknown[] | null>>;
  assert.equal(boardsWarm(b as never), true);
  b.credit!.all = null;
  assert.equal(boardsWarm(b as never), false);
  assert.equal(boardsWarm(null), true);
});

test("the rate boards' floor is 5 scored messages in the Stream window (one stream scores too few) and 20 elsewhere", async () => {
  const { floorFor } = await import("./boardFaces.ts");
  assert.equal(floorFor("stream"), 5);
  for (const w of ["week", "month", "all"] as const) assert.equal(floorFor(w), 20);
});
