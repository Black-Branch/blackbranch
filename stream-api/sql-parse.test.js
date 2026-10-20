// Every static SQL statement in stream-api must PARSE against the real schema.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A statement can be illegal in a way only Postgres sees, for example a
// parameter with no inferable type:
//
//     VALUES ($1, $2, $3, CASE WHEN $3 IS NOT NULL THEN CURRENT_DATE ELSE NULL END)
//
// Postgres rejects that at PARSE time — before a single row is touched — so the
// endpoint 500s on every call, while every suite that drives a MOCK pool stays
// green: a mock returns whatever it was told to return and never asks Postgres
// whether the statement is legal. A broken WHERE clause or a renamed column
// falls through the same hole.
//
// So: replay `schema.sql` + every migration into a throwaway Postgres, then
// PREPARE (parse + plan, execute nothing) every static SQL literal in this
// package against it. CI does the replay; see the `sql-parse` job in
// .github/workflows/ci.yml.
//
// owner/meter.js also reads fin.meter_snapshot, a table owned by an external
// project (its own migrations) — not by anything in this repo's migrations/.
// migrations/replay-into.sh only knows this repo's own schema.sql +
// migrate-v*.sql, so this test loads migrations/external/*.sql itself (see
// below) as an external-schema CONTRACT STUB before preparing anything. That
// directory is a deliberate side door: it is never touched by
// replay-into.sh's migrate-v*.sql glob or any migration applier, and it never
// runs against prod.
//
// Run locally:
//   docker run -d --name sqlprobe -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=stream \
//     -p 55432:5432 pgvector/pgvector:pg18
//   (replay schema.sql + migrations/migrate-v*.sql in numeric order)
//   SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test sql-parse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DIR = __dirname;
const URL = process.env.SQL_PARSE_DATABASE_URL || '';

// A statement count well below today's 97, but far above zero. Without it a
// broken extractor returns [] and this whole file passes by finding nothing —
// the assertion here is "none of them failed", which is exactly the shape that
// goes green on an empty scan.
const MIN_STATEMENTS = 80;

// Comments first, so a backtick inside `// the `SELECT x` query` cannot be
// mistaken for a SQL literal. Line comments before block comments: a `//` can
// legally contain `/*`, and stripping blocks first would splice unrelated code.
const stripComments = (s) =>
  s.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\/\*[\s\S]*?\*\//g, ' ');

const SQL_START = /^\s*(?:WITH|SELECT|INSERT|UPDATE|DELETE)\b/i;

/** Every backticked SQL literal in the package, split into static and interpolated. */
function collect() {
  const statik = [];
  const interpolated = [];
  const isSrc = (f) => f.endsWith('.js') && !f.endsWith('.test.js');
  // The install's owner/ folder runs against the same database; its SQL is held to the
  // same gate. Absent in the public build.
  const owned = fs.existsSync(path.join(DIR, 'owner'))
    ? fs.readdirSync(path.join(DIR, 'owner')).filter(isSrc).map((f) => path.join('owner', f)) : [];
  const files = [...fs.readdirSync(DIR).filter(isSrc), ...owned].sort();
  for (const file of files) {
    const src = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
    // No escapes and no nested backticks: SQL literals here never contain either,
    // and a permissive pattern would swallow whole files between two stray ticks.
    for (const m of src.matchAll(/`([^`\\]*)`/g)) {
      const body = m[1];
      if (!SQL_START.test(body)) continue;
      // A `${…}` literal is a query TEMPLATE, not a statement — its final text
      // depends on runtime values, so there is nothing static to parse.
      (body.includes('${') ? interpolated : statik).push({ file, sql: body.trim() });
    }
  }
  return { statik, interpolated };
}

test('every static SQL statement parses against the real schema', async (t) => {
  if (!URL) {
    // In CI the database is provided by the workflow, so a missing URL means the
    // job is misconfigured — fail rather than skip. A gate that skips itself in
    // CI is the same as no gate, and this one exists because a silent green
    // shipped a 12-day outage.
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — see the sql-parse job');
    t.skip('SQL_PARSE_DATABASE_URL not set (local run without a throwaway Postgres)');
    return;
  }

  const { statik, interpolated } = collect();

  assert.ok(
    statik.length >= MIN_STATEMENTS,
    `found only ${statik.length} static SQL statements (expected >= ${MIN_STATEMENTS}) — ` +
      'the extractor is broken, and an empty scan would pass this file silently'
  );

  // Not a silent cap: say out loud what this gate does NOT cover, so the number
  // moving is visible in the log rather than discovered later.
  console.log(
    `[sql-parse] ${statik.length} static statements checked; ` +
      `${interpolated.length} interpolated templates skipped (runtime-built text)`
  );

  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    // Load external-schema contract stubs BEFORE the rollback-only transaction
    // below: this DDL needs to actually stick around for the PREPAREs to see
    // it, and on a throwaway single-use database there is nothing to clean up
    // (see migrations/external/fin-meter-snapshot.sql for what/why).
    const externalDir = path.join(DIR, '..', 'migrations', 'external');
    // The only stub is for an owner module's read (the meter), so a tree without owner folders — the
    // public repo — has neither the folder nor anything that needs it.
    const stubs = fs.existsSync(externalDir) ? fs.readdirSync(externalDir).filter((n) => n.endsWith('.sql')).sort() : [];
    for (const f of stubs) {
      await client.query(fs.readFileSync(path.join(externalDir, f), 'utf8'));
    }

    // PREPARE is session state; a transaction that always rolls back leaves the
    // throwaway database exactly as it was found. Nothing here executes.
    await client.query('BEGIN');

    // Each PREPARE gets its own savepoint. A failed statement aborts the whole
    // transaction, and every later one then dies with "current transaction is
    // aborted" — which would report 97 failures for one real fault and bury it.
    const prepare = async (name, sql) => {
      await client.query(`SAVEPOINT ${name}`);
      try {
        await client.query(`PREPARE ${name} AS ${sql}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return null;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return err.message;
      }
    };

    // Control: the exact statement that broke production must still be rejected.
    // Without this, a gate that silently stopped detecting parse errors — a bad
    // connection, a swallowed exception — would report success on all 97.
    const controlErr = await prepare(
      'sql_parse_control',
      `INSERT INTO stream.bot_impressions (user_id, impression, today, today_date)
            VALUES ($1, $2, $3, CASE WHEN $3 IS NOT NULL THEN CURRENT_DATE ELSE NULL END)`
    );
    assert.match(
      controlErr || '',
      /could not determine data type/i,
      'the known-bad control statement PREPARED successfully — this gate is not actually checking anything'
    );

    const failures = [];
    for (const [i, s] of statik.entries()) {
      const err = await prepare(`sql_parse_${i}`, s.sql);
      if (err) failures.push(`${s.file}: ${err}\n    ${s.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    assert.deepEqual(failures, [], `SQL that will not parse:\n  - ${failures.join('\n  - ')}`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
