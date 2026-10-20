// The AI-memory controls on the web side (step 2-0, decisions 23 + 27): the viewer's
// own setting, the admin's usercard "forget", and the privacy page that describes
// them. stream-api's memory.js does the work and is tested there against a real
// database (memory.db.test.js); these pin that web reaches it only the right way.
//
// Run: node --test app/lib/memoryOptOut.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (p: string, tail: RegExp) => {
  const raw = readFileSync(join(process.cwd(), p), "utf8");
  assert.match(raw.trimEnd().slice(-300), tail, `${p} did not end as expected — the read is truncated`);
  return stripComments(raw);
};

test("the forget route is admin-only and names the admin as the actor", () => {
  const r = read("app/api/mod/memory/forget/route.ts", /deleted: Number\(d\.deleted\) \|\| 0, lore \}\);\n\}$/);
  assert.match(r, /export async function POST\(req: NextRequest\) \{\n\s*if \(!sameOriginRequest\(req\.headers\)\) return/, "a cross-site form can make an admin forget someone");
  assert.match(r, /const admin = await requireAdmin\(\);\s*if \(!admin\) return new Response\("Forbidden", \{ status: 403 \}\);/);
  assert.match(r, /streamApiFetch\("\/memory\/forget"/);
  assert.match(r, /actor: admin/);
});

test("the setting is the session's own, and only stream-api writes it", () => {
  const r = read("app/api/me/memory/route.ts", /forgotten: Number\(d\.deleted\) \|\| 0 \}\);\n\}$/);
  assert.equal((r.match(/const matrixId = await requireUser\(\);/g) ?? []).length, 2, "GET and PUT must both be the session's");
  assert.match(r, /export async function PUT\(req: NextRequest\) \{\n\s*if \(!sameOriginRequest\(req\.headers\)\) return/, "a cross-site form can switch someone's memory off");
  assert.match(r, /streamApiFetch\("\/memory\/opt-out"/);
  assert.match(r, /optedOut: !body\.remember/);
  assert.doesNotMatch(r, /INSERT INTO site\.memory_opt_outs|DELETE FROM site\.memory_opt_outs/,
    "web wrote the opt-out row itself — turning memory off would then not forget");
});

test("the usercard button is admin-gated and asks first", () => {
  const card = read("app/components/UserCard.tsx", /\n\}$/);
  assert.match(card, /\{badges\.isAdmin && forgetTarget && \(/, "the forget control must be gated on admin, not mod");
  assert.match(card, /setForgetStep\("confirm"\)/);
  assert.match(card, /dryRun: true/, "the confirm must count what will go (lore is shared) before acting");
  assert.match(card, /postJson\("\/api\/mod\/memory\/forget", forgetTarget\)/);
});

test("the Privacy page carries the setting and its help text", () => {
  const page = read("app/components/PrivacySettings.tsx", /\n\}$/);
  assert.match(page, /Let the bot remember my messages/);
  assert.match(page, /recent chat/, "the help text must say the bot still sees recent chat");
  assert.match(page, /fetch\("\/api\/me\/memory"/);
});

test("the privacy policy describes what exists, not a promise", () => {
  const legal = read("app/legal/LegalDocument.tsx", /\n\}$/);
  assert.doesNotMatch(legal, /We are building a privacy setting|until it ships/i,
    "the policy still promises a setting that has shipped");
  assert.match(legal, /Let the bot remember my messages/);
  assert.match(legal, /no \{SITE_NAME\} account, email/, "platform-only chatters must be given the email route");
});
