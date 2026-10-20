// The settings menu vs the settings registry — a census, run as a test.
//
// The failure to guard is a SILENT one — a control that quietly stops being
// listed still works, still saves, still roams and still prepaints, so nothing
// breaks except the user's ability to find it: finished but unreachable,
// editable only by hand-writing localStorage. A census belongs in the build.
//
// SOURCE-TEXT, not imports, and not by choice: `settingsRegistry.ts` imports
// `./chatFont` extensionless, and `node --test` cannot resolve an extensionless
// TS import — importing the registry here kills the whole suite with
// ERR_MODULE_NOT_FOUND. Every other settings guard in this repo (perfSection,
// settingsDefaults, overlayScope) reads the source for the same reason.
//
// Run: node --test app/lib/settingsMenu.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

const REG = read("app", "lib", "settingsRegistry.ts");
const MENU = read("app", "lib", "settingsMenu.ts");

/** Registry keys: the `someKey: E({ … })` entries of ENTRIES. */
const registryKeys = [...REG.matchAll(/^  (\w+): E\(\{/gm)].map((m) => m[1]!);

/** One record per SECTIONS entry, with the keys it lists. */
type Sec = { title: string; tab: string; keys: string[]; body: string };
function parseSections(): Sec[] {
  // Sections are `{ title: "…", tab: "…", items: [ … ] }` — split on the title
  // marker and read each chunk up to the next one.
  const starts = [...MENU.matchAll(/\{ title: "([^"]+)", tab: "(\w+)"/g)];
  return starts.map((m, i) => {
    const from = m.index!;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : MENU.length;
    const body = MENU.slice(from, to);
    return {
      title: m[1]!, tab: m[2]!, body,
      // The lookbehind is load-bearing: a bare /s\("(\w+)"/ also matches the
      // `piIs("bar")` gate helper, which ends in `s(` — that would put
      // "bar"/"dot"/"icon" into the key list as three phantom ghosts.
      keys: [...body.matchAll(/(?<![A-Za-z])s\("(\w+)"/g)].map((k) => k[1]!),
    };
  });
}
const SECS = parseSections();

const listings = new Map<string, string[]>();
for (const sec of SECS)
  for (const k of sec.keys) listings.set(k, [...(listings.get(k) ?? []), sec.title]);

test("the census parses at all — a silent zero would pass every test below", () => {
  assert.ok(registryKeys.length > 60, `parsed only ${registryKeys.length} registry entries`);
  assert.ok(SECS.length > 10, `parsed only ${SECS.length} sections`);
  assert.ok(listings.size > 60, `parsed only ${listings.size} listed keys`);
});

const NOT_A_ROW = new Set(["lowPowerPrev"]); // Low power's memory, written by the switch, never edited by hand

test("every registry setting is reachable in the menu — no orphans", () => {
  const orphans = registryKeys.filter((k) => !listings.has(k) && !NOT_A_ROW.has(k));
  assert.deepEqual(orphans, [],
    "these settings exist, hydrate, prepaint and roam, but no menu row points at " +
    "them — so the only way to change them is by hand in localStorage");
});

test("every menu row points at a real setting — no ghosts", () => {
  const ghosts = [...listings.keys()].filter((k) => !registryKeys.includes(k));
  assert.deepEqual(ghosts, [], "menu rows referencing keys the registry does not define");
});

test("no key appears twice in the SAME section", () => {
  // Cross-listing ACROSS sections would be safe (renderControl keys by setting
  // key, and every copy reads/writes the one shared values object) — the test
  // below keeps it at zero by decision. Twice in one section is the case that
  // collides.
  const clashes: string[] = [];
  for (const sec of SECS) {
    const seen = new Set<string>();
    for (const k of sec.keys) {
      if (seen.has(k)) clashes.push(`${sec.title} → ${k}`);
      seen.add(k);
    }
  }
  assert.deepEqual(clashes, []);
});

test("cross-listings are the deliberate ones", () => {
  const cross = [...listings].filter(([, s]) => s.length > 1).map(([k]) => k).sort();
  // Every switch has ONE home — the Effects section — so the set is empty. A
  // key in two sections again is a decision to make on purpose, then update
  // this expectation.
  assert.deepEqual(cross, [],
    "a key is listed in two sections — every setting lives in exactly one place");
});

test("the seven rail sections are the specs', in order (Behavior added by ⑤, Community by ⑥)", () => {
  const tabs = [...MENU.matchAll(/\{ key: "(\w+)",\s+label: "([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(tabs, ["text:Text", "rows:Chat rows", "colours:Colours", "site:Site & bars", "effects:Effects", "behavior:Behavior", "community:Community"]);
});

test("each key sits in its assigned section", () => {
  const where = (k: string) => SECS.filter((s) => s.keys.includes(k)).map((s) => s.tab);
  const expect: Record<string, string> = {
    usernameSat: "text", shellFont: "text", tabSize: "text", tsFormat: "text",
    nameStylesOn: "rows", showMatrixName: "rows", badgesOn: "rows", pronounColor: "rows", platformPalette: "rows", piSat: "rows", pfpRingWidth: "rows", emoteOverlap: "rows",
    textColor: "colours", tsColor: "colours", fallbackNameMode: "colours", panelTint: "colours", voteColor: "colours",
    sendToBtnOn: "site", toolsBtnOn: "site", frameWidth: "site", panelGap: "site", hideTabBar: "site", streamAutoMute: "site",
    lowPower: "effects", animEmotesOn: "effects", unAnim: "effects", shadowOn: "effects", seamOn: "effects", chatFade: "effects", transparencyOn: "effects", glassColor: "effects", glassOn: "effects",
    histLength: "behavior", spotlightOn: "behavior", mentionSound: "behavior",
    mxLayout: "community", mxAvatars: "community", mxTimes: "community", mxReactSize: "community",
    mxEditedTag: "community", mxDeleted: "community", mxUnread: "community", mxHideMuted: "community",
    mxReceipts: "community", mxTyping: "community",
  };
  for (const [k, tab] of Object.entries(expect)) assert.deepEqual(where(k), [tab], `${k} is in ${where(k).join(",") || "nowhere"}, expected ${tab}`);
});

test("every section belongs to a declared tab, and every tab has sections", () => {
  const tabs = [...MENU.matchAll(/\{ key: "(\w+)",\s+label: "/g)].map((m) => m[1]!);
  assert.ok(tabs.length >= 4, `parsed only ${tabs.length} tabs`);
  for (const sec of SECS)
    assert.ok(tabs.includes(sec.tab), `section "${sec.title}" has unknown tab "${sec.tab}"`);
  for (const t of tabs)
    assert.ok(SECS.some((s) => s.tab === t),
      `tab "${t}" renders nothing — an empty tab is a dead strip position`);
});

test("frameWidth and sendColor are never gated behind a toggle", () => {
  // S-14 / R-18, and the reason is that both do MORE than their names suggest:
  // `frameWidth` sizes the default panel border even with the custom-border
  // toggle OFF, and `sendColor` colours the vote arrows and the poll composer,
  // not only the send button. Gating either hides a control still doing work.
  for (const key of ["frameWidth", "sendColor"])
    assert.match(MENU, new RegExp(`(?<![A-Za-z])s\\("${key}"\\)`),
      `${key} is no longer listed bare — it must appear as s("${key}") with NO showWhen (S-14)`);
});

test("no gate depends on a setting the user cannot reach", () => {
  // A `showWhen` reading `v.foo` where `foo` is itself unlisted would hide its
  // row forever, with nothing in the UI able to reveal it. This is the textual
  // form of the satisfiability check — and it is the half that actually bites,
  // since a gate on a listed setting is always reachable by changing it.
  const gates = [...MENU.matchAll(/showWhen[^)]*?\bv\.(\w+)/g)].map((m) => m[1]!);
  const inline = [...MENU.matchAll(/s\("\w+",\s*\(v\)\s*=>[^)]*v\.(\w+)/g)].map((m) => m[1]!);
  const named = [...MENU.matchAll(/\bv\.(\w+)/g)].map((m) => m[1]!);
  const deps = [...new Set([...gates, ...inline, ...named])];
  assert.ok(deps.length > 0, "no gate dependencies parsed — the regex stopped matching");
  const unreachable = deps.filter((d) => !listings.has(d));
  assert.deepEqual(unreachable, [],
    "a showWhen depends on a setting that has no menu row, so its control can never appear");
});
