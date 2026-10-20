// The sender's pending line for a held message. Without it, a held send
// answers 202, falls into the send hook's success path, and the sender sees
// nothing at all.
//
// Behavioural where the code is pure (the state mapping, the bus). The wiring lives
// in a route and a .tsx the runner cannot execute, so those parts are source scans,
// each proven whole at its END first. The status route's SQL runs against a real
// Postgres when SQL_PARSE_DATABASE_URL is set (CI's replayed throwaway).
//
// Run: node --test app/lib/heldMessages.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";
import { heldStateOf, announceHeld, onHeldMessage } from "./heldMessages.ts";

const read = (p: string, tail: RegExp) => {
  const raw = readFileSync(join(process.cwd(), p), "utf8");
  assert.match(raw.trimEnd().slice(-300), tail, `${p} did not end as expected — the read is truncated`);
  return stripComments(raw);
};

test("row status → what the sender is told", () => {
  assert.equal(heldStateOf("pending"), "pending");
  assert.equal(heldStateOf("allowed"), "approved");
  assert.equal(heldStateOf("denied"), "rejected");
  assert.equal(heldStateOf("expired"), "expired");
  // Anything else was not posted — never "approved" by default.
  assert.equal(heldStateOf("blocked"), "rejected");
  assert.equal(heldStateOf("something-new"), "rejected");
});

test("the bus reports whether a chat list heard it", () => {
  assert.equal(announceHeld({ rowId: 1, text: "x" }), false, "no list mounted: the caller must say it another way");
  const got: number[] = [];
  const off = onHeldMessage((h) => got.push(h.rowId));
  assert.equal(announceHeld({ rowId: 7, text: "x" }), true);
  off();
  assert.deepEqual(got, [7]);
  assert.equal(announceHeld({ rowId: 8, text: "x" }), false);
});

test("the send route returns the held row's id, and a hold with no row is not called held", () => {
  const route = read("app/api/chat/send/route.ts", /return new Response\("OK"\);\n\}$/);
  assert.match(route, /const rowId = await holdBlocklistHit\(/, "the word-filter hold no longer waits for its row id");
  assert.match(route, /const rowId = await holdLinkHit\(/, "the link hold no longer waits for its row id");
  assert.match(route, /held: true, rowId \}, \{ status: 202 \}/);
  assert.match(route, /if \(rowId == null\) \{[\s\S]{0,160}status: 500/, "a failed hold write must not answer 202");
  // A block stays fire-and-forget: the sender is refused either way.
  assert.match(route, /if \(verdict\.action === "block"\) \{\s*recordBlocklistHit\(/);
});

test("the send hook catches a hold BEFORE any success branch", () => {
  const hook = read("app/lib/useSendChatMessage.ts", /return handleSendMessage;\n\}$/);
  const held = hook.indexOf("res.status === 202");
  const spendOk = hook.indexOf("spend && res.ok");
  const plainOk = hook.indexOf("return (d.sentTo");
  assert.ok(held > 0 && held < spendOk && spendOk < plainOk,
    `202 check (${held}) must precede the spend success branch (${spendOk}) — a held paid message would read as bought`);
  assert.match(hook, /announceHeld\(\{ rowId: d\.rowId, text \}\)/);
});

test("the chat list renders held lines and the line polls every 10 s", () => {
  const sidebar = read("app/features/chat/ChatSidebar.tsx", /\n\}$/);
  assert.match(sidebar, /useHeldLines\(messages\)/);
  assert.match(sidebar, /<HeldLine key=\{`held-\$\{h\.rowId\}`\}/);
  const hook = read("app/lib/useHeldLines.ts", /return \{ heldLines: lines, dismissHeld: dismiss \};\n\}$/);
  assert.match(hook, /fetch\(`\/api\/chat\/held\/\$\{rowId\}`/);
  assert.match(hook, /setInterval\([\s\S]{0,60}HELD_POLL_MS\)/);
  assert.match(hook, /document\.visibilityState !== "visible"/, "polling must pause while the tab is hidden");
});

test("the status route is sender-only and 404s everything else", () => {
  const route = read("app/api/chat/held/[id]/route.ts", /headers: \{ "Cache-Control": "no-store" \} \}\);\n\}$/);
  assert.match(route, /const matrixId = await requireUser\(\);/);
  assert.match(route, /WHERE id = \$1 AND matrix_id = \$2/, "the row must be the session's own");
  assert.match(route, /\[id, matrixId\]/);
  assert.equal((route.match(/status: 404/g) ?? []).length, 2, "a bad id and a someone-else row must both be 404");
  assert.doesNotMatch(route, /SELECT[^`]*\btext\b/, "the route must not hand back the message text");
});

test("the status query, against a real database", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL;
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO site.users (matrix_id) VALUES ('@hm_a:test.local'), ('@hm_b:test.local')`);
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO site.automod_held (source, platform, matrix_id, text, status)
       VALUES ('blocklist', 'native', '@hm_a:test.local', 'held words', 'pending') RETURNING id`);
    const row = inserted.rows[0];
    assert.ok(row, "the fixture row was not written");
    const q = `SELECT status FROM site.automod_held WHERE id = $1 AND matrix_id = $2`;
    assert.equal((await db.query(q, [row.id, "@hm_a:test.local"])).rows[0]?.status, "pending");
    assert.equal((await db.query(q, [row.id, "@hm_b:test.local"])).rows.length, 0, "another account can read the row");
    await db.query(`UPDATE site.automod_held SET status = 'denied' WHERE id = $1`, [row.id]);
    assert.equal(heldStateOf((await db.query(q, [row.id, "@hm_a:test.local"])).rows[0].status), "rejected");
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
});
