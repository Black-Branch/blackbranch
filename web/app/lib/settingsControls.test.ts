import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
// settingsRegistry.ts's real last line is trailing prose (a comment), not code —
// its vacuity anchor is the literal end of that comment, not "}" (ChatSettings.tsx
// genuinely ends with "}", so that anchor still applies there).
const read = (...p: string[]) => {
  const r = readFileSync(join(process.cwd(), ...p), "utf8");
  const end = r.trimEnd();
  assert.ok(end.endsWith("}") || end.endsWith("./settingsMenu — the direction of the dependency is then one-way and obvious."));
  return stripComments(r);
};

test("the registry declares the generic choice control and drops the one-off platformIndicator kind", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /\{ kind: "choice"; label: string; options: readonly \{ value: string; label: string \}\[\];\s*preview\?: \(v: string\) => void \}/);
  assert.match(reg, /\{ kind: "color"; label: string; fallbackKey\?: SettingKey \}/);
  assert.doesNotMatch(reg, /kind: "platformIndicator"/);
  assert.match(reg, /platformIndicator: E\(\{[\s\S]*?kind: "choice", label: "Platform style"/);
});

test("ChatSettings renders choice, colour fallback and low power", () => {
  const cs = read("app", "components", "ChatSettings.tsx");
  assert.match(cs, /case "choice":/);
  assert.match(cs, /control\.fallbackKey \? values\[control\.fallbackKey\] as string/);
  assert.match(cs, /case "lowPower":/);
  assert.doesNotMatch(cs, /case "platformIndicator":/);
});
