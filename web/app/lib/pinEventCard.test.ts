// Pinning an event card with no account behind it — a guest's tip, a Ko-fi or YouTube
// alert card — failed. stream-api persists such a card into site.chat_messages with
// matrix_id NULL (money.js persistEventCard); the pin routes snapshot a site row's name
// as COALESCE(display_name, matrix_id), which is NULL for it, and site.pinned_messages
// .username is NOT NULL, so the INSERT threw and the mod's pin answered 500.
//
// The queries are READ OUT OF the two routes that pin (the mod pin and the crowd
// auto-pin) and run on a real Postgres, so this cannot pass against a fixture copy
// while the real statement stays broken.
//
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/pinEventCard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { stripComments } from "./sourceText.mjs";
import { messageVisibleSql } from "./instanceSchema.generated.mjs";
import { pinSnapshotFrom } from "./pinSnapshot.ts";
import { sourceVisible } from "./messageVisibility.ts";
import { pinAuthor } from "./pinAuthor.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const ROUTES = ["../api/chat/pin/route.ts", "../api/chat/vote/route.ts"] as const;

/** A route's source, with the END of the file proven present (a lost tail fails here). */
function routeSource(path: string): string {
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  const src = stripComments(raw);
  const last = raw.trimEnd().split("\n").slice(-1)[0]!.trim();
  assert.ok(last.length > 0 && src.trimEnd().endsWith(last), `${path}: the scan lost the end of the file`);
  return src;
}

/** The site-row snapshot query, as the route runs it. */
function nativeSnapshotSql(src: string, path: string): string {
  const m = /`(SELECT [^`]*FROM site\.chat_messages m[^`]*)`/.exec(src);
  assert.ok(m?.[1], `${path}: no site.chat_messages snapshot query found — the extractor is broken`);
  return m[1].replace('${messageVisibleSql("m")}', messageVisibleSql("m"));
}

/** The pin INSERT, as the route runs it. */
function pinInsertSql(src: string, path: string): string {
  const m = /`(INSERT INTO site\.pinned_messages[^`]*)`/.exec(src);
  assert.ok(m?.[1], `${path}: no site.pinned_messages INSERT found — the extractor is broken`);
  return m[1];
}

test("both pin routes build what they store from pinSnapshotFrom, never from the raw row", () => {
  for (const path of ROUTES) {
    const src = routeSource(path);
    assert.match(src, /pinSnapshotFrom\(src\.rows\[0\]\)/, `${path}: the stored name and text are not built by pinSnapshotFrom`);
    assert.doesNotMatch(src, /src\.rows\[0\]\.username/, `${path}: the raw row's name reaches the INSERT`);
  }
});

// The card shapes stream-api persists (alert.js buildSystemCard / buildEventCard).
const KOFI_CARD = { type: "message", platform: "system", system: "alert", username: "casey", alertPlatform: "kofi",
  eventType: "donation", label: "donated", message: "", amountText: "$5.00" };
const GUEST_TIP = { system: "donation", username: "Gadget Fan", donorMatrixId: null, matrixId: null, anonymous: false,
  amount: 500, currency: "usd", message: "" };

test("an authorless event card is pinnable from either route, and the pin reads back after a restart", async (t) => {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI — see the web job's replay step");
    t.skip("SQL_PARSE_DATABASE_URL not set (local run without a throwaway Postgres)");
    return;
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  t.after(() => db.end());
  await db.query("BEGIN");
  t.after(() => db.query("ROLLBACK").catch(() => {}));
  const q = (sql: string, params: unknown[]) => db.query(sql, params);

  // Exactly as persistEventCard writes them: no matrix_id, the card's text as `message`.
  const persist = async (kind: string, card: object) => (await db.query(
    `INSERT INTO site.chat_messages (matrix_id, message, event_kind, event_json, created_at)
     VALUES (NULL, $1, $2, $3, NOW()) RETURNING id`,
    [String((card as { message?: string }).message || ""), kind, JSON.stringify(card)],
  )).rows[0].id as string;
  const kofi = Number(await persist("alert", KOFI_CARD));
  const guest = Number(await persist("donation", GUEST_TIP));

  for (const path of ROUTES) {
    const src = routeSource(path);
    const select = nativeSnapshotSql(src, path);
    const insert = pinInsertSql(src, path);
    const params = (row: { username: string; message: string; emotes: unknown }) =>
      path.includes("vote") ? ["native", 0, row.username, row.message, row.emotes] : ["native", 0, row.username, row.message, row.emotes, "@mod:site.test"];

    for (const [id, name, text] of [[kofi, "casey", "donated $5.00"], [guest, "Gadget Fan", "tipped $5.00"]] as const) {
      const rows = (await db.query(select, [id])).rows;
      assert.equal(rows.length, 1, `${path}: the card was not found by the snapshot query`);
      // The original failure, kept visible: the raw row has no name at all.
      assert.equal(rows[0].username, null, "precondition: an authorless card's account name is NULL");

      // Original path: what the route stores now.
      const snap = pinSnapshotFrom(rows[0]);
      const p = params(snap);
      p[1] = id;
      await db.query("SAVEPOINT pin");
      try {
        const stored = (await db.query(insert, p)).rows[0];
        assert.equal(stored.username, name, `${path}: the pin does not carry the card's name`);
        assert.equal(stored.message, text, `${path}: the pin carries no text for a card with no message`);
      } catch (e) {
        assert.fail(`${path}: pinning an authorless card failed (${(e as Error).message}) — the route answers 500`);
      } finally {
        await db.query("ROLLBACK TO SAVEPOINT pin");
      }

      // Retry: pinning the same card a second time stores the same thing.
      const again = pinSnapshotFrom((await db.query(select, [id])).rows[0]);
      assert.deepEqual(again, snap, `${path}: a second pin of the same card differs from the first`);
    }
  }

  // Restart: a stored pin of an authorless card is read back by GET (sourceVisible, then
  // pinAuthor) in a process that has nothing but the row.
  assert.equal(await sourceVisible("native", guest, q), true, "GET would unpin the authorless card as gone");
  assert.deepEqual(await pinAuthor("native", guest, q), { matrixId: null, usernameColor: null, usernameStyle: null });
});

test("pinSnapshotFrom: a chat line is stored as it was; a card's own text wins over the summary", () => {
  assert.deepEqual(pinSnapshotFrom({ username: "casey", message: "hello", emotes: { a: "b" } }),
    { username: "casey", message: "hello", emotes: { a: "b" } });
  assert.deepEqual(pinSnapshotFrom({ username: null, message: "keep going!", emotes: null, event_kind: "donation",
    event_json: { ...GUEST_TIP, message: "keep going!" } }), { username: "Gadget Fan", message: "keep going!", emotes: null });
  // An unreadable payload still pins.
  assert.deepEqual(pinSnapshotFrom({ username: null, message: "", emotes: null, event_kind: "alert", event_json: "{oops" }),
    { username: "Anonymous", message: "sent support", emotes: null });
});
