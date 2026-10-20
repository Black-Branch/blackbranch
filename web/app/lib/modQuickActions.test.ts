// The per-message mod actions are written once and used by the live
// chat row's ⋯, the Chat history row's ⋯ and the user card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { banTargetOf, timeoutLabel } from "./modQuickActions.ts";
import { stripComments } from "./testSource.ts";

const web = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");

test("the target rule: a site account by Matrix id, else the canonical id, else nobody", () => {
  assert.deepEqual(banTargetOf({ id: 1, platform: "native", matrixId: "@a:x", canonicalId: "abcdefabcdef" }), { targetId: "@a:x" });
  assert.deepEqual(banTargetOf({ id: 1, platform: "twitch", matrixId: null, canonicalId: "abcdefabcdef" }), { canonicalId: "abcdefabcdef" });
  assert.equal(banTargetOf({ id: 1, platform: "twitch" }), null);
});

test("timeout labels", () => {
  assert.equal(timeoutLabel(10), "10m");
  assert.equal(timeoutLabel(120), "2h");
  assert.equal(timeoutLabel(2880), "2d");
});

test("ONE menu component on both rows, its actions from the one helper", () => {
  const menu = stripComments(read("app/components/MessageContextMenu.tsx"));
  assert.match(menu, /from "@\/app\/lib\/modQuickActions";/);
  // Time out and ban act at once (an Undo follows); purge keeps its confirm.
  assert.match(menu, /run\("", modBanAtOnce\(msg, mins\)\)/);
  assert.match(menu, /run\("", modBanAtOnce\(msg\)\)/);
  assert.doesNotMatch(menu, /Confirm ban/, "no confirm before a ban any more");
  assert.match(menu, /run\("Purge 24h", modPurge\(msg\)\)/);
  assert.match(menu, /armed === "purge" \? "Confirm purge \(24h\)\?" : "Purge last 24h"/, "purge is two-step, visibly");
  assert.match(menu, /\{!inModPanel && \(/, "no Open in mod panel inside the mod panel");
  const live = stripComments(read("app/features/chat/ChatMessage.tsx"));
  // The canonical comes from the mod lookup (useModIds): a live line carries only its public id.
  assert.match(live, /const modIds = useModIds\(msg, !!onModDelete\);/);
  assert.match(live, /msg=\{onModDelete && msg\.id != null && !msg\.system \? \{ id: msg\.id, platform: msg\.platform, matrixId: msg\.matrixId, canonicalId: modIds\.canonicalId \} : undefined\}/,
    "the live row hands the menu its message — mods only (onModDelete), real lines only");
  const hist = stripComments(read("app/features/moderation/sections/ChatHistorySection.tsx"));
  assert.match(hist, /<MessageContextMenu[\s\S]{0,200}msg=\{\{ id: menu\.m\.id, platform: menu\.m\.platform, matrixId: menu\.m\.matrixId, canonicalId: menu\.m\.canonicalId \}\}/);
  assert.match(hist, /<MessageContextMenu[\s\S]{0,600}inModPanel/, "the Chat history's menu knows it is in the mod panel");
  const card = stripComments(read("app/components/UserCard.tsx"));
  assert.match(card, /import \{ timeoutLabel, lastTimeoutMins, rememberTimeoutMins, modBanAtOnce, type ModTargetMsg \} from "@\/app\/lib\/modQuickActions";/, "the card shares the remembered timeout and the at-once ban");
  assert.doesNotMatch(card, /const LAST_TIMEOUT_KEY/, "no second copy of the key");
});

test("the user card shows the message's details in its mod section", () => {
  const card = stripComments(read("app/components/UserCard.tsx"));
  assert.match(card, /<MessageDetails platform=\{msg\.platform\} id=\{msg\.id\} \/>/);
  const details = stripComments(read("app/components/MessageDetails.tsx"));
  assert.match(details, /const scores = messageScores\(\);/, "scores come from the plugin's declaration");
  assert.match(details, /\{scores\.map\(\(s\) => \(/);
  for (const f of ["Message", "Time", "From", "Sent to", "User id", "Matrix id", "Deleted"]) assert.ok(details.includes(`label="${f}"`), f);
});
