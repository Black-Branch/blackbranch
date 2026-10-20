import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "../lib/testSource.ts";

const card = stripComments(fs.readFileSync(path.join(process.cwd(), "app/components/ProfileCardBody.tsx"), "utf8"));
const own = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/OwnCard.tsx"), "utf8"));

test("ProfileCardBody folds its account rows behind one Settings row only when asked", () => {
  assert.match(card, /foldRows\?: boolean;/);
  assert.match(card, /const \[rowsOpen, setRowsOpen\] = useState\(false\);/);
  assert.match(card, /settingsFoldLabel\(\{ verdict, pendingVerification: !!pendingVerification \}\)/);
  // The fold row: closed shows the label + CaretRight, open shows "Settings" + CaretDown, both toggle.
  assert.match(card, /\{foldRows && \(\s*<Row onClick=\{\(\) => setRowsOpen\(\(v\) => !v\)\} icon=\{rowsOpen \? <CaretDown size=\{13\} weight="bold" \/> : <CaretRight size=\{13\} weight="bold" \/>\}>/);
  assert.match(card, /\{rowsOpen \? "Settings" : settingsFoldLabel\(/);
  // The seven rows render only when not folded, or when opened.
  assert.match(card, /\{\(!foldRows \|\| rowsOpen\) && \(\s*<>\s*<Row\s+onClick=\{\(\) => onNavigate\("security"\)\}/);
  assert.match(card, /import \{ settingsFoldLabel \} from "@\/app\/lib\/profileCardFold";/);
  assert.ok(card.trimEnd().endsWith("}"), "END anchor");
});

test("Home's own card is the only caller that folds; the user-menu card keeps every row open", () => {
  assert.match(own, /<ProfileCardBody\b[\s\S]*?\bfoldRows\s*\/>/);
  const others = ["app/components/AccountCard.tsx"].map((f) => stripComments(fs.readFileSync(path.join(process.cwd(), f), "utf8")));
  for (const src of others) assert.doesNotMatch(src, /foldRows/);
  assert.ok(own.trimEnd().endsWith("}"), "END anchor");
});
