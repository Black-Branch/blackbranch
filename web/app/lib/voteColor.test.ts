// Run: node --test app/lib/voteColor.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 500); return stripComments(r); };

test("vote arrows and the score follow --chat-vote-color, falling back to the send colour", () => {
  const row = read("app", "features", "chat", "ChatMessage.tsx");
  const FALL = "var(--chat-vote-color, var(--chat-send-color, var(--accent)))";
  assert.ok(row.includes(`score > 0 ? "${FALL}"`), "score colour not split");
  assert.ok(row.includes("text-[color:var(--chat-vote-color,var(--chat-send-color,var(--accent)))]"), "up-arrow colour not split");
});

test("empty = follow send colour: the property is REMOVED, never written blank", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /voteColor:\s*"",/);
  assert.match(reg, /voteColor: E\(\{[\s\S]*?\(v as string\) \? setProp\("--chat-vote-color", v as string\) : rmProp\("--chat-vote-color"\)/);
  assert.match(reg, /fallbackKey: "sendColor"/);
});
