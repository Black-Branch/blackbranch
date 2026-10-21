// The Leaderboard as a public install renders it (no site plugin, so no per-message scores): the
// four AI-score faces are not offered, and a face remembered from them falls back to the vote score.
// Its own file: the plugin seam resolves once per process, and TEST_NO_OWNER must be set before it.
// Run: node --test app/features/home/boardsWidget.public.render.test.ts
process.env.TEST_NO_OWNER = "1";
import "../../lib/testTsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dom } from "../../lib/testDom.ts";
const { BoardsWidget } = await import("./widgets/BoardsWidget.tsx");
const { FACE_IDS, FACES, WINDOW_IDS } = await import("../../lib/boardFaces.ts");
// The AI faces' labels are read from the face table, never written here: the words belong to the plugin.
const AI_FACES = ["wholesome", "toxic", "bigBrain", "smallBrain"] as const;
const label = (id: string) => FACES.find((f) => f.id === id)!.label;
const { facesShown, faceShown } = await import("./boardFacesShown.ts");

const boards = () => Object.fromEntries(FACE_IDS.map((f) => [f, Object.fromEntries(WINDOW_IDS.map((w) => [w, []]))])) as never;
const html = () => renderToStaticMarkup(createElement(BoardsWidget, { boards: boards(), loading: false, live: false, signedIn: false }));

test("no scoring plugin: the four AI-score faces are not chips; the product's faces are", () => {
  const h = html();
  for (const id of AI_FACES) assert.doesNotMatch(h, new RegExp(`>${label(id)}</button>`), id);
  for (const l of ["Earned points", "Streams", "Top messages", "Top emotes"]) assert.match(h, new RegExp(`>${l}</button>`), l);
});

test("a face remembered from an install that had it (the hostile karma face) shows the vote score instead", () => {
  dom.window.localStorage.setItem("home_board_face", "toxic");
  try {
    const h = html();
    assert.doesNotMatch(h, new RegExp(`<h2[^>]*>${label("toxic")}</h2>`));
    assert.match(h, /aria-pressed="true"[^>]*>Karma</);
  } finally { dom.window.localStorage.removeItem("home_board_face"); }
});

test("each AI face needs its own score: karma brings the two karma faces, intelligence the two brain faces", () => {
  const ids = (keys: string[]) => facesShown(keys.map((key) => ({ key }))).map((f) => f.id);
  assert.deepEqual(ids([]), ["points", "credit", "creditRate", "streams", "messages", "emotes"]);
  assert.deepEqual(ids(["karma"]).filter((f) => (AI_FACES as readonly string[]).includes(f)), ["wholesome", "toxic"]);
  assert.deepEqual(ids(["intelligence"]).filter((f) => (AI_FACES as readonly string[]).includes(f)), ["bigBrain", "smallBrain"]);
  assert.equal(ids(["karma", "intelligence"]).length, FACE_IDS.length, "with both, every face");
  assert.equal(faceShown("toxic", facesShown([])), "credit");
  assert.equal(faceShown("streams", facesShown([])), "streams");
});
