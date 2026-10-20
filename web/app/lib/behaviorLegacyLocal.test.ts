// Signed-out ignore lists saved before chat lines carried public ids (D1).
//
// Those entries are keyed by canonical ids no frame carries any more, so the people
// on them stopped being hidden. Nothing may translate them for a browser; what is
// safe is kept, and the viewer is told once, by name, to hide the rest again.
//
// Run: node --test app/lib/behaviorLegacyLocal.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom } from "./testDom.ts";
import { migrateLegacyLocal, reHideNotice } from "./behaviorLegacyLocal.ts";
import { hiddenMatcher } from "./behaviorLists.ts";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

await import("./testTsx.ts");
const store = await import("./behaviorStore.ts");

const LOCAL_KEY = "bb_behavior_lists";

test("entries that are already public ids keep working, untouched", () => {
  const lists = { hidden: [{ id: "pub-twitch-abc", name: "casey", matrixId: null }], words: ["x"] };
  const out = migrateLegacyLocal(lists);
  assert.equal(out.reHide, null, "nothing old → no notice");
  assert.equal(out.lists, lists, "and the lists are returned as they were");
});

test("an old canonical entry with a site account keeps hiding its site lines; one without is dropped", () => {
  const out = migrateLegacyLocal({
    hidden: [
      { id: "pub-kick-1", name: "kept", matrixId: null },
      { id: "0a1b2c3d4e5f", name: "sam", matrixId: "@sam:site.test" },
      { id: "abcdefabcdef", name: "robin", matrixId: null },
    ],
    words: [],
  });
  assert.deepEqual(out.lists.hidden, [
    { id: "pub-kick-1", name: "kept", matrixId: null },
    { id: "@sam:site.test", name: "sam", matrixId: "@sam:site.test" },
  ]);
  assert.deepEqual(out.reHide, ["sam", "robin"], "both are named — sam's platform lines are no longer covered either");
  const hidden = hiddenMatcher(out.lists);
  assert.equal(hidden({ matrixId: "@sam:site.test" }), true, "sam's site lines stay hidden");
  assert.equal(hidden({ publicId: "pub-kick-1" }), true);
});

test("the notice names people, and caps a long list", () => {
  assert.match(reHideNotice(["sam", "robin"]), /sam, robin\. Hide them again/);
  assert.match(reHideNotice(["a", "b", "c", "d", "e", "f", "g"]), /a, b, c, d, e and 2 more/);
});

test("signed out: the store migrates the browser copy once and says so once", async () => {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem(LOCAL_KEY, JSON.stringify({
    hidden: [{ id: "0a1b2c3d4e5f", name: "sam", matrixId: null }, { id: "pub-yt-9", name: "kept", matrixId: null }],
    words: [],
  }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  try {
    const lists = await store.currentLists();
    assert.deepEqual(lists.hidden.map((h) => h.id), ["pub-yt-9"]);
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(LOCAL_KEY)!).hidden.map((h: { id: string }) => h.id), ["pub-yt-9"],
      "the migrated list is written back, so the old keys are gone");
    const first = await store.takeReHideNotice();
    assert.match(first ?? "", /sam\. Hide them again/);
    assert.equal(await store.takeReHideNotice(), null, "one time only");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the chat box shows the notice on mount", () => {
  const src = stripComments(readFileSync(new URL("../features/chat/ChatInput.tsx", import.meta.url), "utf8"));
  assert.match(src, /void takeReHideNotice\(\)\.then\(\(text\) => \{/);
});
