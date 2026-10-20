// Run: node --test app/lib/siteChanges.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 300); return stripComments(r); };

test("the badge maker lives in the Admin Panel (Site → Badges), not in viewer settings or the mod panel", () => {
  assert.ok(!existsSync(join(process.cwd(), "app", "components", "BadgeManager.tsx")), "BadgeManager.tsx still exists");
  assert.doesNotMatch(read("app", "components", "ChatSettings.tsx"), /BadgeManager|BadgesSection/);
  assert.doesNotMatch(read("app", "features", "moderation", "ModPanel.tsx"), /Badges/);
  assert.match(read("app", "features", "instance", "AdminPanel.tsx"), /if \(section === "site" && sub === "badges"\) return <BadgesAdmin \/>;/);
});

test("the appearance window header carries no popout button", () => {
  assert.doesNotMatch(read("app", "components", "AccountCard.tsx"), /label="Popout chat"/);
  assert.match(read("app", "components", "StreamView.tsx"), /window\.open\("\/popout"/, "Alt+Shift+P must still open the popout");
});
