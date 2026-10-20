// Removed settings stay removed.
// Run: node --test app/lib/removedSettings.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 500); return stripComments(r); };
const GONE = ["usernameSize", "iconScale", "barColor", "timerGlow", "foldedControls"];
const GONE_LS = ["chatStyle_usernameSize", "chatStyle_iconScale", "theme_barColor", "chatStyle_timerGlow", "chatStyle_foldedControls"];
const GONE_CSS = ["--chat-username-size", "--chat-icon-scale", "--support-bar-color", "timer-low-glow", "no-timer-glow", "folded-ctl-off"];

test("registry, menu and pre-paint no longer know the removed settings", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  const menu = read("app", "lib", "settingsMenu.ts");
  const layout = read("app", "layout.tsx");
  for (const k of GONE) {
    assert.doesNotMatch(reg, new RegExp(`\\b${k}:`), `${k} still in the registry`);
    assert.doesNotMatch(menu, new RegExp(`s\\("${k}"`), `${k} still in the menu`);
  }
  for (const ls of GONE_LS) assert.ok(!layout.includes(`'${ls}'`), `pre-paint still reads ${ls}`);
  assert.match(reg, /sendColor: E\(/, "registry read short — negatives above are vacuous");
});

test("no component or stylesheet still consumes a removed variable or class", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p); continue; }
      if (!/\.(tsx?|css)$/.test(e) || /\.test\./.test(e)) continue;
      const s = stripComments(readFileSync(p, "utf8"));
      for (const tok of GONE_CSS) if (s.includes(tok)) offenders.push(`${p}: ${tok}`);
    }
  };
  walk(join(process.cwd(), "app"));
  assert.deepEqual(offenders, []);
});

test("the wrap indent follows the timestamp format, in the registry and the pre-paint", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /const fmt = ctx\.get\("tsFormat"\);[\s\S]{0,400}tsIndentWidth\(fmt\)/, "the ch table is the fallback when the time cannot be measured");
  const layout = read("app", "layout.tsx");
  assert.ok(layout.includes("localStorage.getItem('chatStyle_tsFormat')"), "pre-paint ignores the format");
  for (const w of ["6.5", "4.5", "7.5", "10", "7"]) assert.ok(layout.includes(`'${w}'`) || layout.includes(`:${w}`), `pre-paint width table lacks ${w}`);
});

test("Community \"rel\" rows re-render: Timeline/ThreadPanel read useMinuteTick, and the memoized row compares tick", () => {
  const timeline = read("app", "features", "community", "Timeline.tsx");
  const threadPanel = read("app", "features", "community", "ThreadPanel.tsx");
  const row = read("app", "components", "MatrixMessageRow.tsx");
  assert.match(timeline, /useMinuteTick\(/, "Timeline.tsx never reads useMinuteTick — a \"rel\" row would freeze");
  assert.match(threadPanel, /useMinuteTick\(/, "ThreadPanel.tsx never reads useMinuteTick — a \"rel\" row would freeze");
  assert.match(row, /a\.tick\s*!==\s*b\.tick/, "rowPropsEqual does not compare tick — the memo would swallow a tick change");
});
