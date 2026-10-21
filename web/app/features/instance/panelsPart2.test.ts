// The panel split: the Mod Panel holds exactly its list of places, everything else is in the
// Admin Panel once, no label is in both, the plugin's place lands where it says, and the Admin
// Panel switches places without a navigation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminRail, adminItemFor, adminHref, adminSearch, adminPlacesFor, adminPlaceParts, SUBS } from "./adminLayout.ts";
import { MOD_PLACES, MOD_TARGET_PLACE, modSearch, searchModPlaces } from "../moderation/modLayout.ts";
import { adminPanels } from "../../lib/plugins/absent/admin.ts";
import { stripComments } from "../../lib/testSource.ts";

const web = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");

test("the Mod Panel's places, plus Bans, with Display · Automod queue · Slow mode · Purge as ONE place", () => {
  assert.deepEqual(MOD_PLACES.map((p) => p.label),
    ["Chat history", "Mod history", "Bans", "Reports", "Chat controls", "Lockdown", "Identity links"]);
  assert.equal(MOD_TARGET_PLACE, "bans", "a user card's shield opens Bans");
});

test("nothing that moved to the Admin Panel is still in the Mod Panel", () => {
  const raw = read("app/features/moderation/ModPanel.tsx");
  const panel = stripComments(raw);
  for (const gone of ["TimerSection", "BarSection", "EffectsSection", "BadgesSection", "SupportSection", "PaymentsSection", "plugins/mod", "MOD_PANEL_TABS"]) {
    assert.ok(!panel.includes(gone), `ModPanel still renders ${gone}`);
  }
  assert.match(raw, /\{shown === "identity" && <IdentitySection note=\{note\} \/>\}\s*<\/div>\s*<\/RailLayout>[\s\S]*?<ModUndoToast \/>\s*<\/div>\s*\);\s*\}\s*$/, "read to its end");
});

test("the moved places are in the Admin Panel, once each", () => {
  const ids = adminRail([]).map((x) => x.id);
  for (const id of ["utility/timer", "utility/bar", "utility/effects", "site/badges", "site/tickets", "payments/history"]) {
    assert.equal(ids.filter((x) => x === id).length, 1, `${id} placed once`);
  }
  // Timer, Support bar and Effects are OBS's own places (nested under it).
  const util = adminRail([]).filter((x) => x.section === "utility");
  assert.deepEqual(util.map((x) => [x.sub, x.depth]), [["obs", 0], ["timer", 1], ["bar", 1], ["effects", 1], ["tts", 0], ["overlays", 0]]);
  const panel = stripComments(read("app/features/instance/AdminPanel.tsx"));
  for (const [cond, el] of [
    ['section === "payments" && sub === "history"', '<PaymentHistory onSetup={() => go("payments/connections")} />'],
    ['section === "utility" && sub === "timer"', "<TimerControls note={note} />"],
    ['section === "utility" && sub === "bar"', "<SupportBarControls note={note} />"],
    ['section === "utility" && sub === "effects"', "<EffectsControls note={note} />"],
    ['section === "site" && sub === "badges"', "<BadgesAdmin />"],
    ['section === "site" && sub === "tickets"', "<SupportTickets note={note} />"],
  ]) assert.ok(panel.includes(`if (${cond}) return ${el};`), `${cond} renders ${el}`);
});

test("no label is in both panels", () => {
  const mod = new Set(MOD_PLACES.map((p) => p.label.toLowerCase()));
  const plugin = [{ section: "ai", key: "behavior", label: "Bot behavior", after: "bot" }];
  const admin = adminRail(plugin);
  assert.ok(admin.length >= 20, `vacuity: ${admin.length} admin places`);
  for (const a of admin) {
    assert.ok(!mod.has(a.label.toLowerCase()), `"${a.label}" is in both panels`);
    assert.ok(!mod.has(a.group.toLowerCase()), `"${a.group}" (a group) is a mod label`);
  }
});

test("a plugin's place nests after the place it names; without a plugin there is none", () => {
  assert.deepEqual(adminPanels, []);
  const rail = adminRail([{ section: "ai", key: "behavior", label: "Bot behavior", after: "bot" }]);
  const ai = rail.filter((x) => x.section === "ai").map((x) => `${x.sub}:${x.depth}${x.plugin ? "*" : ""}`);
  assert.deepEqual(ai, ["models:0", "bot:0", "behavior:1*", "scoring:0", "automod:0", "helpdesk:0", "embeddings:0"]);
  // One naming a place that does not exist goes to the section's end, not nested.
  const end = adminRail([{ section: "site", key: "x", label: "X", after: "nope" }]).filter((x) => x.section === "site").at(-1)!;
  assert.deepEqual([end.sub, end.depth, end.plugin], ["x", 0, true]);
  // A plugin may not shadow a product place.
  assert.equal(adminRail([{ section: "ai", key: "bot", label: "Mine" }]).filter((x) => x.id === "ai/bot").length, 1);
});

test("the owner plugin registers its bot controls through the seam, as AI → Chat Bot → Bot behavior", () => {
  const seam = stripComments(read("app/lib/plugins/admin.ts"));
  assert.match(seam, /import \{ adminPanels \} from "@owner\/admin";/);
  assert.match(stripComments(read("app/features/instance/AdminPanel.tsx")), /import \{ ADMIN_PLUGIN_PANELS \} from "@\/app\/lib\/plugins\/admin";/);
});

test("URLs: a place is /admin/<section>?sub=<sub>; Doctor and Updates have none", () => {
  const rail = adminRail([]);
  assert.equal(adminHref(adminItemFor(rail, "utility", "timer")), "/admin/utility?sub=timer");
  assert.equal(adminHref(adminItemFor(rail, "doctor", null)), "/admin/doctor");
  assert.equal(adminItemFor(rail, "site", "nope").id, "site/general", "an unknown sub opens the section's first place");
  assert.deepEqual(SUBS.doctor, []);
});

test("search finds a place by a key on it, and the mod search by its words", () => {
  const rail = adminRail([]);
  assert.ok(adminSearch(rail, "stripe").some((x) => x.id === "payments/connections"));
  assert.ok(adminSearch(rail, "subathon").some((x) => x.id === "utility/timer"));
  assert.equal(adminSearch(rail, "").length, rail.length);
  assert.deepEqual(adminSearch(rail, "zzzz-nothing"), []);
  assert.deepEqual(modSearch("raid"), ["lockdown"]);
  assert.ok(modSearch("whitelist").includes("controls"));
  assert.ok(modSearch("slow mode").includes("controls"));
});

test("one search for both panels: each lists the other's places, and a key's hint matches", () => {
  assert.ok(adminSearch(adminRail([]), "install prompt").some((x) => x.id === "site/general"), "the site name's description");
  assert.deepEqual(adminPlacesFor("", []), [], "an empty query lists nothing from the other panel");
  assert.ok(adminPlacesFor("stripe", []).some((x) => x.panel === "admin" && x.id === "payments/connections"));
  assert.deepEqual(searchModPlaces("purge"), [{ panel: "mod", id: "controls", label: "Chat controls" }]);
  assert.deepEqual(searchModPlaces("   "), []);
  assert.deepEqual(adminPlaceParts("ai/bot"), { section: "ai", sub: "bot" });
  assert.deepEqual(adminPlaceParts("doctor"), { section: "doctor", sub: null });
  assert.equal(adminPlaceParts("nope/x"), null);
});

test("a place switch is client state + pushState, never a router navigation", () => {
  const raw = read("app/features/instance/AdminPanel.tsx");
  const panel = stripComments(raw);
  assert.doesNotMatch(panel, /router\.push|useRouter/);
  assert.match(panel, /if \(syncUrl\) window\.history\.pushState\(null, "", adminHref\(it\)\);/);
  assert.match(panel, /window\.addEventListener\("popstate", onPop\);/);
  assert.match(raw, /<KeyCards view=\{inst\} groups=\{keyGroupsFor\(section, sub, inst\.ownerPlugin !== false\)\} onChanged=\{loadInst\} note=\{note\} placeLabel=\{item\.label\} \/>\s*<\/>\s*\);\s*\}\s*$/, "read to its end");
});

test("the pages render the same windows, never a bare page of links", () => {
  const admin = stripComments(read("app/(main)/admin/[section]/page.tsx"));
  assert.match(admin, /return <AdminPopout section=\{section\} sub=\{typeof sub === "string" \? sub : undefined\} \/>;/);
  assert.match(admin, /if \(!\(await requireAdmin\(\)\)\) redirect\("\/"\);/);
  assert.doesNotMatch(admin, /<Link|← Mod panel/);
  const pop = stripComments(read("app/(main)/admin/[section]/AdminPopout.tsx"));
  assert.match(pop, /<AdminWindow popout section=\{section\} sub=\{sub\}/);
  const win = stripComments(read("app/features/instance/AdminWindow.tsx"));
  assert.match(win, /<AdminPanel section=\{section\} initialSub=\{sub\} syncUrl=\{popout\} onPlace=\{setHref\} onOpenMod=\{onOpenMod\} \/>/);
  assert.match(win, /title="Admin panel"/);
});

test("the profile card offers the Admin panel to admins only", () => {
  const card = stripComments(read("app/components/ProfileCardBody.tsx"));
  assert.match(card, /\{badges\.isAdmin && \(\s*<Row onClick=\{onOpenAdmin\}/);
});

test("Mod history: shows 8, then 16, then pages of 16, with a search", () => {
  const sec = stripComments(read("app/features/moderation/sections/HistorySection.tsx"));
  assert.match(sec, /const FIRST = 8;/);
  assert.match(sec, /const PAGE = 16;/);
  assert.match(sec, /page === 0 && hasMore && <button className=\{btn\} onClick=\{\(\) => setPage\(1\)\}>Show 16<\/button>/);
  assert.match(sec, /aria-label="Search the mod history"/);
  const route = stripComments(read("app/api/mod/log/route.ts"));
  assert.match(route, /LIMIT \$1 OFFSET \$2/);
  assert.match(route, /COALESCE\(l\.reason, ''\) ILIKE '%' \|\| \$\$\{n\}::text \|\| '%'/);
});
