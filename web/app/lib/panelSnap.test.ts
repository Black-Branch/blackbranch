import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { snapZoneFor, THEATRE_ZONE, FULL_MARGIN } from "./panelSnap.ts";

test("dragging the chat shut arms chatFolded, never theatre", () => {
  assert.equal(snapZoneFor(THEATRE_ZONE - 1, 1400), "chatFolded");
  assert.equal(snapZoneFor(THEATRE_ZONE, 1400), null);
  assert.equal(snapZoneFor(1400 - FULL_MARGIN + 1, 1400), "full");
  assert.equal(snapZoneFor(700, 1400), null);
});

test("the hook's drag path reaches theatre by NO route: only the button / Alt+R do", () => {
  const src = stripComments(readFileSync(new URL("./usePanelResize.ts", import.meta.url), "utf8"));
  assert.match(src, /snapZoneFor\(raw, window\.innerWidth\)/);
  assert.doesNotMatch(src, /"theatre"\s*:/);          // no ternary that yields theatre
  assert.match(src, /"normal" \| "theatre" \| "full" \| "chatFolded"/);
  assert.match(src, /return \{ panelMode, snapZone, snapping, applyMode, resizeHandlers \};\s*\}\s*$/); // END anchor
});

test("StreamView folds the chat for chatFolded exactly as for theatre, and only the chat", () => {
  const src = stripComments(readFileSync(new URL("../components/StreamView.tsx", import.meta.url), "utf8"));
  const folded = (src.match(/panelMode === "theatre" \|\| panelMode === "chatFolded"/g) ?? []).length;
  assert.ok(folded >= 3, `chat width, both borders and the edge tab must all fold: found ${folded}`);
  // The bars' overlay/fill logic keys on theatre ALONE — a folded chat keeps the bars in flow and the dock.
  // The call sits on one line under the video bars' fold ternary. `chatFolded`
  // reaches NEITHER input — that is the half this asserts; the fold branch
  // overrides the RESULT, never these inputs.
  assert.match(src, /barVisibility\(\{ narrow, barsHidden, theatre: panelMode === "theatre" \}\)/);
  // Desktop compact keeps the dock, so only theatre and the PHONE's hidden
  // bars fill; `chatFolded` still reaches neither.
  assert.match(src, /const fillMode = panelMode === "theatre" \|\| \(narrow && !bars\.barsInFlow\);/);
  assert.match(src, /Release to fold chat"/);
  assert.doesNotMatch(src, /theatre mode"/);
  assert.match(src, /\}\);\s*$/); // END anchor
});
