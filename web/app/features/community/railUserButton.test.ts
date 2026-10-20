// The rail's bottom avatar duplicates the UserMenu whenever one is mounted
// beside it (split view: the live composer's UserMenu sits a pane away).
// It must hide exactly then, and ONLY then: on the
// standalone/mobile paths it is the only door to the account card.
// Run: node --test app/features/community/railUserButton.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("the rail avatar hides exactly when a UserMenu is mounted beside it", () => {
  const rail = read("app", "features", "community", "SpacesRail.tsx");
  assert.match(rail, /hideUserButton\?: boolean;/, "SpacesRail must expose the gate");
  assert.match(rail, /\{!hideUserButton && <RailUserButton /, "the bottom avatar is gated, not deleted — standalone paths still need it");
  assert.match(rail, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");

  const view = read("app", "features", "community", "MatrixView.tsx");
  assert.match(view, /<SpacesRail[\s\S]{0,600}hideUserButton=\{hideUserMenu\}/,
    "the gate rides the SAME truth that already hides the timeline's UserMenu");

  const sidebar = read("app", "features", "chat", "ChatSidebar.tsx");
  assert.match(sidebar, /hideUserMenu=\{split && isSignedIn\}/, "split WITH a signed-in viewer is what puts a UserMenu beside the rail — signed out the composer is a sign-in CTA and the avatar must stay");
});
