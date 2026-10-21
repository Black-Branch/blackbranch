import { test } from "node:test";
import assert from "node:assert/strict";
import { foldForVisit, OPEN_HOME_EVENT, OPEN_LIVE_EVENT } from "./visitFold.ts";

test("W31 — offline desktop: fold the player, open Home, and leave the chat SHOWN (a first visit) or as the viewer left it", () => {
  assert.deepEqual(
    foldForVisit({ live: false, narrow: false, storedPlayerMode: "live", storedPanelMode: null }),
    { player: "fold", chat: null, openHome: true },
  );
  assert.deepEqual(
    foldForVisit({ live: false, narrow: false, storedPlayerMode: "live", storedPanelMode: "normal" }),
    { player: "fold", chat: null, openHome: true },
    "an unfolded chat is never folded by a visit",
  );
});

test("W31 — a community feed on at load unfolds the video to it; the chat stays as left", () => {
  assert.deepEqual(
    foldForVisit({ live: false, community: true, narrow: false, storedPlayerMode: "none", storedPanelMode: null }),
    { player: "unfold", chat: null, openHome: false },
  );
  assert.deepEqual(
    foldForVisit({ live: false, community: true, narrow: true, storedPlayerMode: "community", storedPanelMode: null }),
    { player: null, chat: null, openHome: false },
  );
});

test("offline, already folded from last visit: nothing to write, Home still opens", () => {
  assert.deepEqual(
    foldForVisit({ live: false, narrow: false, storedPlayerMode: "none", storedPanelMode: "chatFolded" }),
    { player: null, chat: null, openHome: true },
  );
});

test("theatre and full stand ENTIRELY on desktop — the dock is not mounted there, so folding the player would leave a bar over nothing", () => {
  for (const mode of ["theatre", "full"]) {
    assert.deepEqual(
      foldForVisit({ live: false, narrow: false, storedPlayerMode: null, storedPanelMode: mode }),
      { player: null, chat: null, openHome: false },
    );
  }
  // A phone ignores panelMode, so a stray stored theatre must not stop the phone's fold.
  assert.deepEqual(
    foldForVisit({ live: false, narrow: true, storedPlayerMode: null, storedPanelMode: "theatre" }),
    { player: "fold", chat: null, openHome: true },
  );
});

test("offline phone: fold the player, there is no chat to fold, open Home", () => {
  assert.deepEqual(
    foldForVisit({ live: false, narrow: true, storedPlayerMode: "radio", storedPanelMode: null }),
    { player: "fold", chat: null, openHome: true },
  );
});

test("live: unfold a folded player and a folded chat; never touch the open tab", () => {
  assert.deepEqual(
    foldForVisit({ live: true, narrow: false, storedPlayerMode: "none", storedPanelMode: "chatFolded" }),
    { player: "unfold", chat: "normal", openHome: false },
  );
  assert.deepEqual(
    foldForVisit({ live: true, narrow: false, storedPlayerMode: "live", storedPanelMode: null }),
    { player: null, chat: null, openHome: false },
  );
  assert.deepEqual(
    foldForVisit({ live: true, narrow: true, storedPlayerMode: "none", storedPanelMode: "chatFolded" }),
    { player: "unfold", chat: null, openHome: false },
    "a phone has no chat fold, and a stray stored chatFolded must not be touched from a phone",
  );
});

test("the event names are the ones the hosts listen for", () => {
  assert.equal(OPEN_HOME_EVENT, "bb:open-home");
  assert.equal(OPEN_LIVE_EVENT, "bb:open-live");
});
