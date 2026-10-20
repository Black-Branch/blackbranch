// Every place that prints a Matrix member's name must go through senderLabel,
// or a bridge ghost shows the bridge's "(Discord)" suffix there — in the
// message row, the members list, thread list, DM rows and forum bylines alike. This scan makes "every renderer" a fact.
//
// Run: node --test app/lib/discordLabelSites.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./testSource.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");

function read(rel: string): string {
  return stripComments(readFileSync(join(APP, rel), "utf8"));
}

const COMMUNITY = readdirSync(join(APP, "features/community"))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => `features/community/${f}`);
const COMPONENTS = readdirSync(join(APP, "components"))
  .filter((f) => /^Matrix.*\.tsx$/.test(f))
  .map((f) => `components/${f}`);

const NAME_CALL = /\b(memberName|getMemberDisplayName)\(/;
const SENDER_LABEL_IMPORT = /import\s*{[^}]*\bsenderLabel\b[^}]*}\s*from\s*"@\/app\/lib\/discordSender"/;
// MemberCard.tsx is the canonical resolver (its exported
// `memberName` already runs the name through senderLabel) — a renderer that
// imports memberName FROM MemberCard, rather than the raw matrixDisplay one,
// gets the Discord strip transitively and doesn't need its own senderLabel import.
const MEMBER_CARD_NAME_IMPORT = /import\s*{[^}]*\bmemberName\b[^}]*}\s*from\s*"@\/app\/components\/MemberCard"/;

test("every file that prints a member name imports senderLabel", () => {
  const offenders: string[] = [];
  for (const rel of [...COMMUNITY, ...COMPONENTS, "components/MemberCard.tsx"]) {
    const src = read(rel);
    const isMemberCard = rel === "components/MemberCard.tsx";
    if (!isMemberCard && !NAME_CALL.test(src)) continue;
    if (!SENDER_LABEL_IMPORT.test(src) && !MEMBER_CARD_NAME_IMPORT.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "these print a member name without the Discord strip");
});

test("every label site resolves the name through senderLabel", () => {
  // MemberList.tsx resolves names through MemberCard.tsx's exported
  // memberName — assert the import literally, so a future list
  // that prints raw names again (bypassing MemberCard) still fails.
  assert.match(
    read("features/community/MemberList.tsx"), MEMBER_CARD_NAME_IMPORT,
    "features/community/MemberList.tsx must import memberName from MemberCard (which resolves through senderLabel)",
  );
  for (const rel of [
    "features/community/ThreadsListPanel.tsx",
    "features/community/ChannelColumn.tsx",
    "features/community/ForumView.tsx",
    "features/community/Timeline.tsx",
    "features/community/ThreadPanel.tsx",
    "components/MatrixHtml.tsx",
  ]) {
    assert.match(read(rel), /senderLabel\(/, `${rel} must call senderLabel`);
  }
});

test("the message row no longer carries its own strip logic", () => {
  const row = read("components/MatrixMessageRow.tsx");
  assert.doesNotMatch(row, /stripDiscordSuffix\(/, "the row must use senderLabel, not the raw strip");
});

// Vacuity anchor at the END: the scan reads the real files, not empty strings.
test("the scan is reading the real sources", () => {
  // memberName's definition lives in MemberCard.tsx — the anchor follows the
  // line, not a file it might once have lived in.
  assert.match(read("components/MemberCard.tsx"), /const memberName = \(m: RoomMember\) =>/);
  assert.match(read("components/MatrixMessageRow.tsx"), /function ReplyPreview\(/);
});
