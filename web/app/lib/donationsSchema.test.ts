// `site.donations` must actually carry what v124 promised, and the statements
// written against it must actually PARSE.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Every other test that touches this table drives a MOCK pool. A mock returns
// whatever it was told to return; it never asks Postgres whether the statement
// is legal, or whether the column exists. That is how a 12-day outage shipped
// green out of stream-api (see stream-api/sql-parse.test.js, which this file
// is the small, table-scoped sibling of).
//
// v124 added `provider`, `external_id` and `provider_ref` so a PayPal tip can
// live in the same ledger as a Stripe one. Two things have to stay true, and
// neither is visible to a source scan:
//
//   1. The migration is actually APPLIED. A column that exists only in
//      migrations/migrate-v124.sql is a column the running code will 500 on.
//   2. `UNIQUE (provider, external_id)` is real AND every writer fills
//      external_id. Postgres permits unlimited NULLs in a unique index, so a
//      writer that leaves it null makes the constraint true of back-filled
//      history and of nothing else — protection that looks present and is not.
//
// The INSERT below is not retyped here: it is READ OUT OF the webhook route, so
// this test cannot drift away from the statement it claims to check. A fixture
// copy would go green while the real query rotted.
//
// Run locally against a throwaway database:
//   docker exec <sandbox-db container> psql -U sandbox -d postgres -c 'CREATE DATABASE replay'
//   ./migrations/replay-into.sh "postgres://sandbox:<pw>@localhost:5433/replay"
//   SQL_PARSE_DATABASE_URL=… node --test app/lib/donationsSchema.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
// The ONE stripper (sourceText.mjs). Not a private copy: sixteen of those in
// three diverging behaviours is what testSource.test.ts exists to prevent, and
// a subtly weaker copy makes a scan measure a subtly different string.
import { stripComments } from "./sourceText.mjs";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";

/** The donations INSERT as the webhook route actually writes it. */
function donationInsert(): string {
  const src = stripComments(
    readFileSync(new URL("../api/billing/webhook/route.ts", import.meta.url), "utf8"),
  );
  const m = /`(INSERT INTO site\.donations[^`\\]*)`/.exec(src);
  assert.ok(
    m?.[1],
    "no `INSERT INTO site.donations` literal found in the billing webhook — the extractor is broken, and an empty scan would pass this file silently",
  );
  return m[1].trim();
}

/** The donations INSERT as the PayPal order route (task 9) actually writes it. */
function paypalDonationInsert(): string {
  const src = stripComments(
    readFileSync(new URL("../api/billing/paypal/order/route.ts", import.meta.url), "utf8"),
  );
  const m = /`(INSERT INTO site\.donations[^`\\]*)`/.exec(src);
  assert.ok(
    m?.[1],
    "no `INSERT INTO site.donations` literal found in the PayPal order route — the extractor is broken, and an empty scan would pass this file silently",
  );
  return m[1].trim();
}

test("the Stripe recorder fills external_id — or the new UNIQUE protects nothing", () => {
  const sql = donationInsert();
  const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)?.[1] ?? "";
  const values = /VALUES\s*\(([^)]*)\)/i.exec(sql)?.[1] ?? "";
  assert.ok(cols.includes("stripe_session_id"), "vacuity anchor: the column list did not parse");
  assert.ok(
    cols.split(",").some((c) => c.trim() === "external_id"),
    "the donations INSERT no longer writes external_id: Postgres allows unlimited NULLs in a unique index, so UNIQUE (provider, external_id) would silently stop protecting anything written from here on",
  );
  // Same placeholder for both, so the two can never disagree about one row.
  const i = cols.split(",").findIndex((c) => c.trim() === "stripe_session_id");
  const j = cols.split(",").findIndex((c) => c.trim() === "external_id");
  assert.equal(
    values.split(",")[i]?.trim(),
    values.split(",")[j]?.trim(),
    "stripe_session_id and external_id must be written from the SAME placeholder — a Stripe row whose two keys disagree cannot be matched by either",
  );
});

test("the live schema carries what v124 promised, and the statement parses against it", async (t) => {
  if (!DB_URL) {
    // A gate that skips itself in CI is the same as no gate — stream-api's
    // sql-parse gate makes exactly this distinction, for exactly this reason.
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI — see the web job's replay step");
    t.skip("SQL_PARSE_DATABASE_URL not set (local run without a throwaway Postgres)");
    return;
  }
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const cols = await client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'site' AND table_name = 'donations'`,
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
    assert.ok(byName.has("amount_cents"), "vacuity anchor: site.donations was not found at all");
    for (const c of ["provider", "external_id", "provider_ref"]) {
      assert.ok(byName.has(c), `site.donations.${c} is missing — migrate-v124.sql has not been applied to this database`);
    }
    assert.equal(
      byName.get("stripe_session_id"), "YES",
      "stripe_session_id is still NOT NULL — a PayPal tip has no Stripe session, so it could not be recorded at all",
    );

    const uniq = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'site.donations'::regclass AND contype = 'u'`,
    );
    assert.ok(
      uniq.rows.some((r) => /UNIQUE \(provider, external_id\)/.test(r.def)),
      "UNIQUE (provider, external_id) is gone — nothing stops a provider recording the same tip twice",
    );

    // PREPARE parses and plans; it executes nothing. The transaction always
    // rolls back, so the throwaway database is left exactly as it was found.
    await client.query("BEGIN");
    try {
      await client.query(`PREPARE donations_insert_probe AS ${donationInsert()}`);
    } finally {
      await client.query("ROLLBACK");
    }

    // Same probe for the PayPal order route's insert (task 9) — a mock pool
    // cannot reject illegal SQL, and this is the one check that actually
    // asks Postgres whether the statement is legal against the live schema.
    await client.query("BEGIN");
    try {
      await client.query(`PREPARE paypal_donations_insert_probe AS ${paypalDonationInsert()}`);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
});
