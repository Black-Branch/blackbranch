#!/usr/bin/env node
// Nothing may follow a migration's own COMMIT. Run: node tools/check-migration-commit.mjs [migrations dir]
//
// install/migrate.sh applies each migrate-vN.sql with `psql --single-transaction`, so a file that
// fails half-way leaves nothing of itself. A file's own BEGIN/COMMIT does not change that for the
// statements BEFORE its COMMIT — but that COMMIT ends psql's outer transaction, and every statement
// after it runs on its own, outside any transaction: a failure there leaves the migration half
// applied, with its schema_migrations row possibly already written. So a transaction-ending statement
// (COMMIT, END, ROLLBACK, ABORT) may only be a file's LAST statement. Comments, string literals and
// dollar-quoted bodies (a function's `END;`) are not statements and are skipped.
//
// Exit 1 and one line per problem when a file breaks the rule. The install suite runs it
// (install/migrate.test.mjs), so CI's `install` job holds every shipped migration to it.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The statements of a SQL file, with comments, quoted text and dollar-quoted bodies blanked out.
// Each is { text, line } — text whitespace-collapsed, line where it starts (1-based).
export function sqlStatements(sql) {
  const out = [];
  let cur = "", start = null, line = 1, i = 0;
  const push = () => { const t = cur.replace(/\s+/g, " ").trim(); if (t) out.push({ text: t, line: start ?? line }); cur = ""; start = null; };
  const mark = () => { if (start === null) start = line; };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "\n") { line++; cur += " "; i++; continue; }
    if (c === "-" && n === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { // block comments nest in Postgres
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        if (sql[i] === "\n") line++;
        i++;
      } while (i < sql.length && depth > 0);
      cur += " "; continue;
    }
    if (c === "'" || c === '"') { // '' and "" escape themselves; E'…' strings also take \'
      const esc = c === "'" && /[eE]$/.test(cur) && !/[A-Za-z0-9_][eE]$/.test(cur);
      mark(); i++;
      while (i < sql.length) {
        if (esc && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } i++; break; }
        if (sql[i] === "\n") line++;
        i++;
      }
      cur += " Q "; continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]$/.test(cur)) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? sql.length : end + m[0].length;
        mark();
        for (let j = i; j < stop; j++) if (sql[j] === "\n") line++;
        i = stop; cur += " Q "; continue;
      }
    }
    if (c === ";") { push(); i++; continue; }
    if (!/\s/.test(c)) mark();
    cur += c; i++;
  }
  push();
  return out;
}

const ENDS = /^(COMMIT|END|ROLLBACK|ABORT)(\s+(WORK|TRANSACTION))?(\s+AND\s+(NO\s+)?CHAIN)?$/i;

// The problems of one file's text: a statement after a transaction-ending one.
export function commitProblems(sql) {
  const st = sqlStatements(sql);
  const at = st.findIndex((s) => ENDS.test(s.text));
  if (at < 0 || at === st.length - 1) return [];
  const after = st[at + 1];
  return [`line ${after.line}: "${after.text.slice(0, 60)}" runs after the ${st[at].text.toUpperCase()} on line ${st[at].line} — outside the runner's transaction; end the file with its COMMIT`];
}

function main(dir) {
  const files = readdirSync(dir).filter((f) => /^migrate-v\d+\.sql$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (files.length === 0) { console.error(`check-migration-commit: no migrate-v*.sql in ${dir}`); return 1; }
  let bad = 0;
  for (const f of files) for (const p of commitProblems(readFileSync(path.join(dir, f), "utf8"))) { console.error(`${f}: ${p}`); bad++; }
  if (bad) return 1;
  console.log(`check-migration-commit: ${files.length} migrations, nothing after a COMMIT`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")));
}
