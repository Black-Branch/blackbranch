// The Leaderboard's Admin Panel settings, as Home applies them: switched off, Home has no
// Leaderboard card; a board switched off is no chip, a remembered board that is off falls to the
// first one offered, and switching every board off is ignored (all show).
// Its own file: the plugin seam resolves once per process, and TEST_NO_OWNER must be set before it.
// Run: node --test app/features/home/leaderboardSettings.render.test.ts
process.env.TEST_NO_OWNER = "1";
import "../../lib/testTsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dom } from "../../lib/testDom.ts";
const { BoardsWidget } = await import("./widgets/BoardsWidget.tsx");
const { FACE_IDS, FACES, WINDOW_IDS } = await import("../../lib/boardFaces.ts");
const { homeWidgets } = await import("./homeLayout.ts");
const { INSTANCE_KEYS } = await import("../../lib/instanceSchema.generated.mjs");

const label = (id: string) => FACES.find((f) => f.id === id)!.label;
const boards = () => Object.fromEntries(FACE_IDS.map((f) => [f, Object.fromEntries(WINDOW_IDS.map((w) => [w, []]))])) as never;
const html = (hidden?: string[]) => renderToStaticMarkup(createElement(BoardsWidget, { boards: boards(), loading: false, live: false, signedIn: false, hidden }));
const chip = (id: string) => new RegExp(`>${label(id)}</button>`);

test("switched off: Home has no Leaderboard card; on (or unsaid): it has", () => {
  assert.ok(homeWidgets({ vods: false }).some((w) => w.id === "boards"), "on by default");
  assert.ok(!homeWidgets({ vods: false, boards: false }).some((w) => w.id === "boards"));
  const off = INSTANCE_KEYS.find((e) => e.key === "leaderboard.off");
  assert.equal(off?.default, false, "a new install shows the Leaderboard");
  assert.deepEqual(INSTANCE_KEYS.find((e) => e.key === "leaderboard.hidden")?.values, ["points", "credit", "creditRate", "streams", "messages", "emotes"]);
});

test("a board switched off is no chip; the others stay", () => {
  const h = html(["streams", "emotes"]);
  assert.doesNotMatch(h, chip("streams"));
  assert.doesNotMatch(h, chip("emotes"));
  for (const id of ["points", "credit", "messages"]) assert.match(h, chip(id), id);
});

test("the vote score switched off, and remembered: the first board offered shows instead", () => {
  dom.window.localStorage.setItem("home_board_face", "credit");
  try {
    const h = html(["credit"]);
    assert.doesNotMatch(h, chip("credit"));
    assert.match(h, new RegExp(`aria-pressed="true"[^>]*>${label("points")}<`));
  } finally { dom.window.localStorage.removeItem("home_board_face"); }
});

test("every board switched off is ignored: all show", () => {
  const h = html(["points", "credit", "creditRate", "streams", "messages", "emotes"]);
  for (const id of ["points", "credit", "messages"]) assert.match(h, chip(id), id);
});
