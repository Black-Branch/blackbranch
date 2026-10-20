// The chat-appearance panel's presets and tab row.
//
// Run: node --test app/lib/settingsPresets.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { TABS, SECTIONS, type MenuTab } from "./settingsMenu.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(join(here, rel), "utf8"));

test("presets are not a tab — they sit above every tab", () => {
  // They were one tab among five, so applying a saved look meant leaving the
  // controls, clicking, and coming back to see what it did — the one action you
  // most want to take while looking at the thing it changes.
  assert.equal(
    TABS.some((t) => (t.key as string) === "presets"), false,
    "the Presets tab is back — the slots belong above the tab content"
  );
  assert.equal(
    SECTIONS.some((s) => (s.tab as string) === "presets"), false,
    "a section still claims the removed 'presets' tab, so it renders nowhere"
  );
  const src = read("../components/ChatSettings.tsx");
  const body = src.slice(src.indexOf("return ("));
  const slots = body.indexOf("<PresetSlots");
  const sections = body.indexOf("visibleSections.map");
  assert.ok(slots !== -1, "ChatSettings no longer renders the preset slots at all");
  assert.ok(slots < sections, "the preset slots render below the tab content, not above it");
});

test("every section's tab still exists", () => {
  // Removing a tab key is how a section becomes unreachable: it is filtered by
  // `sec.tab === activeTab`, and a section pointing at a deleted tab simply
  // never renders, with no error anywhere.
  const keys = new Set<MenuTab>(TABS.map((t) => t.key));
  for (const s of SECTIONS) {
    assert.ok(keys.has(s.tab), `section "${s.title}" targets tab "${s.tab}", which no tab renders`);
  }
});

test("an applied preset stops being SELECTED on any single setting change", () => {
  // The solid "selected" fill claims "these settings are that preset". The
  // moment one control moves that is false, and the fill must go — without
  // comparing values. House looks keep the slot as the one you picked, EDITED
  // (an outline + dot, and its save button lights up), instead of forgetting
  // it: a one-tap "save my change into it", without a silent autosave.
  const src = read("../components/ChatSettings.tsx");
  const applyKey = src.slice(src.indexOf("const applyKey = useCallback"));
  assert.match(
    applyKey.slice(0, applyKey.indexOf("}, [ctx]);")),
    /setPick\(\(p\) => \(p && !p\.edited \? \{ \.\.\.p, edited: true \} : p\)\)/,
    "applyKey does not mark the picked preset edited — a slot stays SELECTED after " +
    "the settings it claims to describe have been edited"
  );
  const applyBlob = src.slice(src.indexOf("const applyBlob = useCallback"));
  assert.match(
    applyBlob.slice(0, 500), /setPick\(slot \? \{ slot, edited: false \} : null\)/,
    "applying a preset does not mark its slot"
  );
  // Reset is a change too — the loudest one; it forgets the pick entirely.
  assert.match(src, /resetToDefaults\(\);\s*setPick\(null\)/,
    "resetting to defaults leaves a preset slot lit");
  // Selected vs edited are derived from ONE pick, so they can never both show.
  assert.match(src, /appliedSlot=\{pick && !pick\.edited \? pick\.slot : null\}/);
  assert.match(src, /editedFrom=\{pick\?\.edited \? pick\.slot : null\}/);
});

test("the pick survives closing the menu (per browser, per scope)", () => {
  // One copy of the marker: the terminal reads and writes the same key.
  const pick = read("./settingsPick.ts");
  assert.match(pick, /export const PICK_KEY = \(\) => `\$\{settingsScope\(\)\}bb_preset_sel`/);
  const src = read("../components/ChatSettings.tsx");
  assert.match(src, /import \{ readPick, writePick, type Pick \} from "\.\.\/lib\/settingsPick"/);
  assert.doesNotMatch(src, /bb_preset_sel/, "the menu grew its own copy of the key");
  // Written only after hydration, or the first render's null would erase it.
  assert.match(src, /if \(!hydrated\) return;\s*writePick\(pick\)/);
  assert.match(src, /setPick\(readPick\(\)\)/, "the saved pick is never read back");
});

test("saving into a slot makes it the selected one; clearing it drops the pick", () => {
  const src = read("../components/ChatSettings.tsx");
  assert.match(src, /onSaved=\{\(n\) => setPick\(\{ slot: n, edited: false \}\)\}/);
  assert.match(src, /onCleared=\{\(n\) => setPick\(\(p\) => \(p\?\.slot === n \? null : p\)\)\}/);
  // The save goes through ONE store (app/lib/presetStore.ts, shared with the terminal
  // since step 3b), which has both the account and the browser branch; the button
  // reports back once it returns, and says so when it did not.
  const slots = read("../components/PresetSlots.tsx");
  const save = slots.slice(slots.indexOf("const save = async"), slots.indexOf("const apply ="));
  assert.match(save, /await savePreset\(store\(\), n, collectLookSettings\(\)\)/);
  assert.match(save, /onSaved\(n\)/);
  assert.match(save, /setSaveError\(/, "a failed save must say so — it was once swallowed");
  const store = read("./presetStore.ts");
  const savePreset = store.slice(store.indexOf("export async function savePreset"), store.indexOf("export async function clearPreset"));
  assert.match(savePreset, /if \(mode === "account"\)[\s\S]*postJsonOrThrow<\{ preset: Preset \}>\("\/api\/me\/presets", body, "PUT"\)/);
  assert.match(savePreset, /lsSetJSON\(presetKey\(n\), settings\)/);
});

test("each slot takes its colour from slotTone — own, house, selected, edited", () => {
  // The three colours themselves are pinned in houseLooks.test.ts.
  const src = read("../components/PresetSlots.tsx");
  assert.match(src, /slotTone\(view\.kind, appliedSlot === n, editedFrom === n\)/);
  assert.doesNotMatch(src, /slice\(0, 3\)/, "names are cut to three letters again");
  assert.match(src, /truncate/);
});

test("house looks fill empty slots — everywhere but the overlay pages", () => {
  const src = read("../components/PresetSlots.tsx");
  assert.match(src, /resolveSlot\(ownLook\(n\), houseFor\(n\)\)/);
  const at = src.indexOf("loadHouseLooks()");
  assert.ok(at !== -1, "house looks are never fetched");
  const effect = src.slice(src.lastIndexOf("useEffect(", at), at);
  assert.match(effect, /if \(isOverlayScope\(\)\) return;/,
    "the OBS / pop-out pages fetch site house looks into their device-only keyspace");
  assert.match(read("./presetStore.ts"), /getJson<\{ looks: \(Look & \{ slot: number \}\)\[\] \}>\("\/api\/house-looks"\)/);
});

test("the row is labelled Presets, beside the Save row's label", () => {
  const src = read("../components/PresetSlots.tsx");
  assert.match(src, />Presets</);
  assert.match(src, />Save current</);
});

test("clearing your own look brings the house look back — account AND browser", () => {
  const src = read("../components/PresetSlots.tsx");
  const clear = src.slice(src.indexOf("const clear = async"), src.indexOf("const publish = async"));
  assert.match(clear, /await clearPreset\(store\(\), n\)/);
  assert.match(clear, /onCleared\(n\)/);
  const store = read("./presetStore.ts");
  const clearPreset = store.slice(store.indexOf("export async function clearPreset"), store.indexOf("export async function loadHouseLooks"));
  assert.match(clearPreset, /if \(mode === "account"\) await postJsonOrThrow\(`\/api\/me\/presets\?slot=\$\{n\}`, undefined, "DELETE"\)/);
  assert.match(clearPreset, /lsRemove\(presetKey\(n\)\)/, "the browser's copy must go in BOTH modes — or it comes back as a stale import");
  assert.match(src, /menu\.view\.houseBehind \? "Restore house look" : "Clear"/);
});

test("house-look publishing is offered only to a signed-in admin", () => {
  const src = read("../components/PresetSlots.tsx");
  assert.match(src, /const canPublish = mode === "account" && isAdmin === true;/);
  const strip = src.slice(src.indexOf("{menu && ("));
  assert.match(strip, /canPublish && menu\.view\.kind === "own"[\s\S]*Make house look/);
  assert.match(strip, /canPublish && house\[menu\.n\][\s\S]*Remove house look/);
});

test("a house look applied under Low power does not switch its effects back on", () => {
  // A house look never carries Low power (houseBlob strips it), so the merge
  // keeps the viewer's switch ON while the look's glass / shadow / animation
  // land ON. Re-running Low power over the merged values files them in its
  // memory instead, where turning Low power off brings them back.
  const src = read("../components/ChatSettings.tsx");
  const applyBlob = src.slice(src.indexOf("const applyBlob = useCallback"), src.indexOf("function resetToDefaults"));
  assert.match(applyBlob, /if \(blob\[ENTRIES\.lowPower\.ls\] == null && next\.lowPower\)/);
  assert.match(applyBlob, /lowPowerOn\(next as unknown as Record<string, unknown>\)/);
  const lp = applyBlob.indexOf("lowPowerOn(");
  assert.ok(lp < applyBlob.indexOf("valuesRef.current = next"), "Low power re-runs after the values are committed");
});

test("browser presets are imported to the account ONCE, and only into an empty account", () => {
  // Before house looks a slot could never be emptied, so re-importing any slot
  // the server lacked was a harmless self-heal. Now "Restore house look" empties
  // a slot on purpose — and every other browser's old local copy would upload
  // it straight back.
  // The rule lives in the shared store since step 3b (presetStore.test.ts runs it
  // against a fetch stub); the buttons just call loadPresets().
  const src = read("./presetStore.ts");
  assert.match(src, /const importedKey = \(\) => `\$\{settingsScope\(\)\}bb_preset_imported`/);
  assert.match(src, /const importNow = fetched\.length === 0 && !lsGet\(importedKey\(\)\);/);
  assert.match(src, /importNow \? PRESET_SLOTS\.filter/);
  assert.match(src, /lsSet\(importedKey\(\), "1"\)/);
  assert.match(read("../components/PresetSlots.tsx"), /loadPresets\(\)\.then/);
});

test("while the account's own looks load, no slot offers a house look", () => {
  // Otherwise a tap in that window applies the house look over the viewer's own.
  const src = read("../components/PresetSlots.tsx");
  assert.match(src, /const houseFor = \(n: number\): Look \| null => \(mode === "loading" \? null : house\[n\] \?\? null\);/);
});

test("the window band has ONE text slot — title or sections, never both", () => {
  // One header row doing four jobs needs a second line; the chrome Window
  // removes the cause — while tabs are present the title never renders, so
  // the band can never need a second line (NN/g: "use one row of tabs only").
  const src = read("../components/chrome/Window.tsx");
  assert.match(src, /tabs && tabs\.length > 0 \? \(/,
    "the text slot no longer branches on tabs — title and sections could render together");
  assert.doesNotMatch(src, /flex-wrap/,
    "the band wraps again — one text slot exists precisely so it never needs to");
});

test("band controls stay pressable inside the drag handle", () => {
  // A shell that needs a stopPropagation on EVERY header control breaks on
  // the first control nobody remembered. Window guards ONCE, at the handle: a
  // press on anything interactive is not a drag.
  const src = read("../components/chrome/Window.tsx");
  assert.match(src, /closest\('button, \[role="button"\], a, input, select, textarea'\)/,
    "the drag guard is gone — pressing a band control starts a drag instead of a click");
});

test("the index is the door, and it names Window", () => {
  // check-chrome forbids importing chrome internals; this pins the flip side —
  // the door actually exports the shell, so a consumer can obey the gate.
  assert.match(read("../components/chrome/index.ts"), /export \{ Window, type WindowProps \} from "\.\/Window";/,
    "the chrome index stopped exporting Window — every consumer import breaks at the door");
});

test("the seven rail sections carry the agreed grouping", () => {
  // The regroup's contract, pinned title-by-title. Moving a group to another
  // section is a product decision, not a refactor — update this table only
  // with one.
  assert.deepEqual(
    TABS.map((t) => [t.key, t.label]),
    [
      ["text", "Text"],
      ["rows", "Chat rows"],
      ["colours", "Colours"],
      ["site", "Site & bars"],
      ["effects", "Effects"],
      ["behavior", "Behavior"],
      ["community", "Community"],
    ],
  );
  const want: Record<string, string[]> = {
    text: ["Message text", "Names", "Site text", "Timestamps"],
    rows: ["Names & badges", "Platform", "Avatars", "Layout", "Emotes"],
    colours: ["Text colours", "Panel colours", "Borders", "Shape", "Buttons"],
    site: ["Composer", "Sizes", "Tabs", "Player"],
    effects: ["Effects"],
    // Behavior (Highlights lives here, including "hide streamer highlight").
    behavior: ["Sound", "Highlights", "Messages", "People", "Words", "Tabs", "History", "Windows", "Terminal"],
    // Community — its own settings.
    community: ["Timeline", "Edits & deletions", "Channel list", "Privacy"],
  };
  for (const t of TABS) {
    assert.deepEqual(
      SECTIONS.filter((s) => s.tab === t.key).map((s) => s.title),
      want[t.key],
      `the "${t.label}" section's groups (or their order) drifted from the approved table`,
    );
  }
  // The group count is pinned — a regroup moves sections, it never loses one.
  // A removed SETTING can remove a group; a merge or a new section changes the
  // count on purpose. Update the number only with such a change.
  assert.equal(SECTIONS.length, 32);
});
