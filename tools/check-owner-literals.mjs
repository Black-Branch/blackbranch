#!/usr/bin/env node
// The literal gate: a RATCHET over the three packages, zero over the folders that ship as they are,
// and zero over a whole tree (`--tree`, the public cut's acceptance).
//
// WHAT THIS IS FOR. The platform is installed by other streamers, so a value that belongs to one
// install — its domain, its people, its channel ids, its LAN — must not be written into the code;
// such values live in the settings layer. The gate keeps new ones from landing faster than old ones
// leave. So, per package:
//
//   · a file's count may only go DOWN;
//   · a file not in the baseline must have NONE;
//   · `--update` locks a lowered count in, and it can only ever LOWER;
//   · raising a count means editing tools/owner-literals.baseline.json by hand, in the same commit.
//
// A LOWERED COUNT ALSO FAILS until it is locked in: a baseline above reality is slack the next
// change can grow back into. Exact equality is also the baseline's own vacuity anchor.
//
// COMMENTS ARE COUNTED: a public reader sees them (the inverse of check-orphans, which strips
// comments because a mention is not a call site; here the mention IS the thing measured).
//
// TWO PATTERN FILES. tools/literals.json holds the structure and the NEUTRAL patterns (a
// private-network address, a home folder, a personal email address, a live key) and ships with the
// public repo. tools/owner-literals.json holds one owner's names and never ships; its patterns are
// added whenever it is present, and a tree with owner folders must have it (or the gate refuses —
// a private tree checked with the neutral patterns alone would pass the owner's names).
//
// RATCHET PATTERNS. A pattern too widespread to clear in one change (an owner's word in hundreds of
// comments) carries its own per-file ceilings (`ratchet: { path: n }`) in its pattern file. The
// package scan, the baseline and --zero leave it out; each package run holds it to those ceilings
// over every file of the package but the owner folders — tests included, because the public tree
// publishes them — with the same rules (only down; a file not listed holds none; --update lowers),
// and --tree forgives exactly the ceiling of each file. The ceilings live with the private pattern,
// so the public repo, which has neither, has nothing to fail on.
//
// It lives at the repo root, outside all three packages: stream-api's deploy copies its `*.js`
// files and stream-ingest is copied whole, so a scanner inside either one ships to a server.
//
// Usage:
//   node tools/check-owner-literals.mjs <package>          check one package (+ the zero paths)
//   node tools/check-owner-literals.mjs --update [<pkg>…]  lower the baseline to match (never raises)
//   node tools/check-owner-literals.mjs --zero <package>   the package at zero, whatever the baseline
//   node tools/check-owner-literals.mjs --tree [<dir>] [--patterns <file>]…
//       every file git lists in <dir> (default: this repo), every pattern, no exclusion — zero.
//       --patterns adds another pattern file (the private side passes its owner file when it checks
//       the public cut, which does not contain one).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(import.meta.url), "../..");
export const CONFIG_PATH = join(REPO, "tools", "literals.json");
export const OWNER_PATH = join(REPO, "tools", "owner-literals.json");
export const BASELINE_PATH = join(REPO, "tools", "owner-literals.baseline.json");

/** The file types a tree may hold as binary. */
export const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|eot|mp3|wav|ogg|opus|m4a|webm|mp4|pdf|zip|gz|tgz|br|wasm)$/i;

/**
 * @typedef {{ name: string, re: string, why: string, allow?: Record<string, string>, caseSensitive?: boolean, source?: string,
 *             ratchet?: Record<string, number> }} Pattern
 * @typedef {{
 *   patterns: Pattern[], packages: string[],
 *   ownerRoots: { paths: string[] },
 *   zeroPaths: Record<string, string>,
 *   notScanned: { segments: Record<string,string>, prefixes: Record<string,string>,
 *                 files: Record<string,string> }
 * }} Config
 */

/**
 * Patterns from one pattern file, each checked: a reason, a valid regex, a reason per allowed match.
 * @param {string} path @param {string} source
 * @returns {Pattern[]}
 */
export function loadPatterns(path, source) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.patterns) || !raw.patterns.length) throw new Error(`${path} has no patterns — the gate would count nothing`);
  return raw.patterns.map((/** @type {Pattern} */ p) => {
    if (!p.why || p.why.length < 8) throw new Error(`pattern "${p.name}" has no reason — every pattern says why it is a literal`);
    new RegExp(p.re, p.caseSensitive ? "g" : "gi");
    for (const [re, why] of Object.entries(p.allow ?? {})) {
      new RegExp(re, "i");
      if (typeof why !== "string" || why.length < 8) throw new Error(`pattern "${p.name}": allowed match "${re}" has no reason`);
    }
    for (const [file, n] of Object.entries(p.ratchet ?? {})) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`pattern "${p.name}": the ratchet ceiling for ${file} must be a whole number above 0`);
    }
    return { ...p, source };
  });
}

/**
 * The gate's configuration: the structure and neutral patterns of `path`, plus the owner patterns of
 * `ownerPath` when that file exists. `extra` adds more pattern files (`--patterns`).
 * @returns {Config}
 */
export function loadConfig(path = CONFIG_PATH, { ownerPath = OWNER_PATH, extra = /** @type {string[]} */ ([]) } = {}) {
  /** @type {Config} */
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.patterns = loadPatterns(path, "neutral");
  if (ownerPath && existsSync(ownerPath)) cfg.patterns.push(...loadPatterns(ownerPath, "owner"));
  // The public cut passes the owner file twice (the cut ref's and this checkout's): a pattern loaded
  // again is the same pattern, not a second one — counted once, and for a ratchet the stricter of
  // the two ceilings per file (a file only one of them lists keeps no allowance).
  for (const f of extra) {
    for (const p of loadPatterns(f, f)) {
      const same = cfg.patterns.find((q) => q.name === p.name && q.re === p.re && !!q.caseSensitive === !!p.caseSensitive);
      if (!same) { cfg.patterns.push(p); continue; }
      if (same.ratchet || p.ratchet) {
        /** @type {Record<string, number>} */
        const both = {};
        for (const [file, n] of Object.entries(same.ratchet ?? {})) if (p.ratchet?.[file]) both[file] = Math.min(n, p.ratchet[file]);
        same.ratchet = both;
      }
    }
  }
  if (!cfg.zeroPaths || !Object.keys(cfg.zeroPaths).some((k) => k !== "//")) {
    throw new Error("literals.json has no zeroPaths — migrations/baseline/ would go unscanned");
  }
  for (const [k, why] of Object.entries(cfg.zeroPaths)) {
    if (k === "//") continue;
    if (!k.endsWith("/")) throw new Error(`zero path "${k}" must end in "/" — it names a folder`);
    if (typeof why !== "string" || why.length < 8) throw new Error(`zero path "${k}" has no reason`);
  }
  for (const group of ["segments", "prefixes", "files"]) {
    for (const [k, why] of Object.entries(cfg.notScanned[group] ?? {})) {
      if (k === "//") continue;
      if (typeof why !== "string" || why.length < 8) throw new Error(`exclusion "${k}" has no reason`);
    }
  }
  return cfg;
}

/**
 * A tree that has an owner folder is a private tree, and a private tree checked without the owner's
 * pattern file would pass every owner name. Throws then.
 * @param {Config} cfg @param {string} root
 */
export function requireOwnerPatterns(cfg, root = REPO) {
  const present = cfg.ownerRoots.paths.filter((p) => existsSync(join(root, p)));
  if (present.length && !cfg.patterns.some((p) => p.source === "owner")) {
    throw new Error(`this tree has owner folders (${present.join(", ")}) but no tools/owner-literals.json — refusing to check it with the neutral patterns alone`);
  }
}

/**
 * Is this repo-relative path counted at all?
 * @param {string} path repo-relative, forward slashes
 * @param {Config} cfg
 */
export function isScanned(path, cfg) {
  if (cfg.ownerRoots.paths.some((root) => path.startsWith(root))) return false;
  const parts = path.split("/");
  if (parts.some((seg) => Object.hasOwn(cfg.notScanned.segments, seg))) return false;
  if (Object.keys(cfg.notScanned.prefixes ?? {}).some((p) => p !== "//" && path.startsWith(p))) return false;
  return !Object.keys(cfg.notScanned.files).some((re) => new RegExp(re, "i").test(path));
}

/**
 * Occurrences of every owner pattern in `text`. RAW text — comments count.
 * @param {string} text
 * @param {Config} cfg
 */
export function countLiterals(text, cfg, opts = {}) {
  return findLiterals(text, cfg, opts).length;
}

/**
 * Every counted match in `text`, with its pattern's name — a match an `allow` entry names is not one.
 * `skipRatchet`: leave out the ratchet patterns (the package scan: they keep their own ceilings).
 * @param {string} text @param {Config} cfg @param {{ skipRatchet?: boolean }} [opts]
 * @returns {{ name: string, match: string, index: number }[]}
 */
export function findLiterals(text, cfg, { skipRatchet = false } = {}) {
  /** @type {{ name: string, match: string, index: number }[]} */
  const found = [];
  for (const p of cfg.patterns) {
    if (skipRatchet && p.ratchet) continue;
    const allow = Object.keys(p.allow ?? {}).map((re) => new RegExp(re, "i"));
    for (const m of text.matchAll(new RegExp(p.re, p.caseSensitive ? "g" : "gi"))) {
      if (!allow.some((a) => a.test(m[0]))) found.push({ name: p.name, match: m[0], index: m.index ?? 0 });
    }
  }
  return found;
}


/**
 * A whole tree — the public cut's acceptance: every file git lists in `dir` (tracked, plus
 * untracked-not-ignored), every pattern, NO exclusion (tests, docs, fixtures and this gate's own
 * files included: all of it is published) — over each file's PATH as well as its text. A binary file (a NUL byte) has no text and is skipped.
 * @param {string} dir @param {Config} cfg
 * @returns {{ scanned: number, binary: number, perPackage: Record<string, number>,
 *             found: Record<string, { name: string, line: number }[]>, ratcheted: number }}
 */
export function scanTree(dir, cfg) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = [...new Set(out.split("\0").filter(Boolean))].filter((p) => existsSync(join(dir, p)));
  /** @type {Record<string, { name: string, line: number }[]>} */
  const found = {};
  /** @type {Record<string, number>} */
  const perPackage = Object.fromEntries(cfg.packages.map((p) => [p, 0]));
  let scanned = 0, binary = 0, ratcheted = 0;
  for (const path of files) {
    // The PATH is published as plainly as the text: a file or folder named after the owner (an
    // owner-named output file once shipped this way at zero hits) is a finding at "line 0".
    const inPath = findLiterals(path, cfg).map((h) => ({ name: `${h.name} (in the path)`, line: 0 }));
    if (inPath.length) found[path] = inPath;
    const buf = readFileSync(join(dir, path));
    if (buf.includes(0)) {
      // Only a known media/font/archive type may be binary; a NUL byte anywhere else would hide the
      // file's text from this scan (and from gitleaks), so it is a finding of its own.
      if (BINARY_FILE.test(path)) { binary++; continue; }
      found[path] = [...inPath, { name: "binary content in a file that should be text", line: 1 }];
      continue;
    }
    scanned++;
    const pkg = cfg.packages.find((p) => path.startsWith(`${p}/`));
    if (pkg) perPackage[pkg]++;
    const text = buf.toString("utf8");
    // A ratchet pattern's matches are forgiven up to the file's ceiling, all or none: above it,
    // every match is reported with the count and the ceiling.
    const hits = findLiterals(text, cfg).flatMap((h) => {
      const p = cfg.patterns.find((x) => x.name === h.name);
      if (!p?.ratchet) return [h];
      const mine = findLiterals(text, { ...cfg, patterns: [p] }).length;
      const ceiling = p.ratchet[path] ?? 0;
      if (mine <= ceiling) { ratcheted++; return []; }
      return [{ ...h, name: `${h.name} (${mine}, ceiling ${ceiling})` }];
    });
    if (hits.length) {
      found[path] = [...inPath, ...hits.map((h) => ({ name: h.name, line: text.slice(0, h.index).split("\n").length }))];
    }
  }
  return { scanned, binary, perPackage, found, ratcheted };
}

/**
 * Every repo-relative file in `pkg` that git knows about or would add —
 * tracked plus untracked-not-ignored. Ignored files (.env, build output) are
 * never read: a local secrets file is neither code nor something CI can see,
 * and a gate that disagreed with CI about which files exist is two gates.
 * @param {string} pkg
 */
export function listPackageFiles(pkg) {
  const out = execFileSync(
    "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `${pkg}/`],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // --cached still lists a file deleted in the working tree; it has no text.
  return [...new Set(out.split("\0").filter(Boolean))].filter((p) => existsSync(join(REPO, p)));
}

/**
 * @param {string} pkg
 * @param {Config} cfg
 * @returns {{ scanned: number, counts: Record<string, number> }} only files with count > 0
 */
export function scanPackage(pkg, cfg, files = listPackageFiles(pkg)) {
  /** @type {Record<string, number>} */
  const counts = {};
  let scanned = 0;
  for (const path of files) {
    if (!isScanned(path, cfg)) continue;
    scanned++;
    const n = countLiterals(readFileSync(join(REPO, path), "utf8"), cfg, { skipRatchet: true });
    if (n > 0) counts[path] = n;
  }
  if (scanned === 0) throw new Error(`check-owner-literals (${pkg}): scanned 0 files — the walk is blind`);
  return { scanned, counts };
}

/**
 * Each RATCHET pattern's count per file of `pkg` — every file but the owner folders and binaries,
 * tests and docs included (the public tree publishes them, and --tree holds them to the same
 * ceilings). The pattern's own `ratchet` map is the baseline these are compared with.
 * @param {string} pkg @param {Config} cfg
 * @returns {Record<string, Record<string, number>>} pattern name → { path: count } (counts > 0)
 */
export function scanRatchets(pkg, cfg, files = listPackageFiles(pkg),
  read = (/** @type {string} */ p) => readFileSync(join(REPO, p), "utf8")) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  const ratchets = cfg.patterns.filter((p) => p.ratchet);
  for (const p of ratchets) out[p.name] = {};
  if (!ratchets.length) return out;
  for (const path of files) {
    if (cfg.ownerRoots.paths.some((root) => path.startsWith(root)) || BINARY_FILE.test(path)) continue;
    const text = read(path);
    for (const p of ratchets) {
      const n = findLiterals(text, { ...cfg, patterns: [p] }).length;
      if (n > 0) out[p.name][path] = n;
    }
  }
  return out;
}

/** --update for ratchet patterns: lower each owner-file pattern's ceilings for `pkg` (never raise). */
function lowerRatchets(pkg, cfg, found, path = OWNER_PATH) {
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  let changed = false;
  for (const p of raw.patterns) {
    if (!p.ratchet || !(p.name in found)) continue;
    const next = lowerBaseline(pkg, found[p.name], p.ratchet);
    if (JSON.stringify(next) !== JSON.stringify(p.ratchet)) { p.ratchet = next; changed = true; }
  }
  if (changed) writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}

/**
 * One zero path (a folder outside the packages that ships to every install): EVERY file in it is
 * counted — no exclusion applies, because whatever sits there is published as it is.
 * @param {string} prefix a zeroPaths key, ending in "/"
 * @param {Config} cfg
 * @returns {{ present: boolean, scanned: number, counts: Record<string, number> }}
 */
export function scanZeroPath(prefix, cfg, files = listPackageFiles(prefix.replace(/\/$/, "")),
  read = (/** @type {string} */ p) => readFileSync(join(REPO, p), "utf8")) {
  /** @type {Record<string, number>} */
  const counts = {};
  // A known media/font file holds no text; any other file is read whole.
  const mine = files.filter((p) => p.startsWith(prefix) && !BINARY_FILE.test(p));
  for (const path of mine) {
    const n = countLiterals(read(path), cfg);
    if (n > 0) counts[path] = n;
  }
  return { present: mine.length > 0, scanned: mine.length, counts };
}

/** Every zero path, checked. Returns false when any holds an owner literal. */
function checkZeroPaths(cfg) {
  let clean = true;
  for (const prefix of Object.keys(cfg.zeroPaths).filter((k) => k !== "//")) {
    const { present, scanned, counts } = scanZeroPath(prefix, cfg);
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!present) { console.log(`check-owner-literals (${prefix}): not present yet — nothing to scan`); continue; }
    if (n) {
      clean = false;
      console.error(`\ncheck-owner-literals (${prefix}): ${n} owner literal(s) — this folder ships to every install and must hold NONE:`);
      for (const [f, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.error(`  ${c}  ${f}`);
    } else console.log(`check-owner-literals (${prefix}): ok — 0, held at zero (${scanned} scanned)`);
  }
  return clean;
}

/** Baseline entries that belong to `pkg`. */
const inPkg = (pkg) => (path) => path.startsWith(`${pkg}/`);

/**
 * Compare one package's counts with the baseline.
 * @param {string} pkg
 * @param {Record<string, number>} counts
 * @param {Record<string, number>} baseline
 */
export function compare(pkg, counts, baseline) {
  const raised = [], added = [], lowered = [], stale = [];
  for (const [path, n] of Object.entries(counts)) {
    const base = baseline[path];
    if (base === undefined) added.push({ path, now: n });
    else if (n > base) raised.push({ path, base, now: n });
    else if (n < base) lowered.push({ path, base, now: n });
  }
  for (const [path, base] of Object.entries(baseline)) {
    if (inPkg(pkg)(path) && counts[path] === undefined) stale.push({ path, base, now: 0 });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const baseTotal = Object.entries(baseline).filter(([p]) => inPkg(pkg)(p)).reduce((a, [, b]) => a + b, 0);
  return { raised, added, lowered, stale, total, baseTotal };
}

/**
 * The baseline after `--update` for `pkg`: every entry lowered to what was
 * found, zeros dropped. It can only LOWER — a file above its baseline keeps
 * the old number, and a file not in the baseline is never added. Both stay
 * failures for a human to fix or to argue in a hand edit.
 * @param {string} pkg
 * @param {Record<string, number>} counts
 * @param {Record<string, number>} baseline
 */
export function lowerBaseline(pkg, counts, baseline) {
  /** @type {Record<string, number>} */
  const next = {};
  for (const [path, base] of Object.entries(baseline)) {
    if (!inPkg(pkg)(path)) { next[path] = base; continue; }
    const now = Math.min(base, counts[path] ?? 0);
    if (now > 0) next[path] = now;
  }
  return next;
}

/** @returns {{ header: unknown, files: Record<string, number> }} */
export function readBaseline(path = BASELINE_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { header: raw["//"], files: raw.files ?? {} };
}

function writeBaseline(header, files, path = BASELINE_PATH) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(path, JSON.stringify({ "//": header, files: sorted }, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--tree") {
    // --tree [<dir>] [--patterns <file>]… — the matched TEXT is never printed (one pattern is a live
    // key), only where it is and which pattern matched.
    const extra = [];
    let dir = REPO;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--patterns") extra.push(resolve(args[++i] ?? ""));
      else dir = resolve(args[i]);
    }
    const cfg = loadConfig(CONFIG_PATH, { extra });
    requireOwnerPatterns(cfg, dir);
    const { scanned, binary, perPackage, found, ratcheted } = scanTree(dir, cfg);
    const blind = Object.entries(perPackage).filter(([, n]) => n === 0).map(([p]) => p);
    if (blind.length) {
      console.error(`check-owner-literals --tree: read no file of ${blind.join(", ")} in ${dir} — the walk is blind`);
      process.exit(1);
    }
    const sources = [...new Set(cfg.patterns.map((p) => p.source === "neutral" || p.source === "owner" ? p.source : "extra"))];
    const n = Object.values(found).reduce((a, h) => a + h.length, 0);
    if (n) {
      console.error(`check-owner-literals --tree: ${n} literal(s) in ${Object.keys(found).length} file(s) — the whole tree must hold NONE:`);
      for (const [f, hits] of Object.entries(found).sort()) {
        for (const h of hits) console.error(`  ${f}:${h.line}  ${h.name}`);
      }
      process.exit(1);
    }
    const held = ratcheted ? `; ${ratcheted} held under a ratchet (may only go down)` : "";
    console.log(`check-owner-literals --tree: ok — 0 in ${scanned} files (${binary} binary skipped; patterns: ${sources.join(" + ")}, ${cfg.patterns.length}${held})`);
    process.exit(0);
  }
  const update = args.includes("--update");
  // --zero: the public export's acceptance — no owner literal at all, whatever the
  // baseline says. Run on a tree with the owner folders removed (tools/public-export.sh).
  const zero = args.includes("--zero");
  const cfg = loadConfig();
  requireOwnerPatterns(cfg);
  const named = args.filter((a) => a !== "--update" && a !== "--zero");
  const pkgs = named.length ? named : update ? cfg.packages : [];
  if (!pkgs.length) {
    console.error("usage: node tools/check-owner-literals.mjs <package> | --update [<package>…] | --zero <package>");
    process.exit(2);
  }
  if (zero) {
    let total = 0;
    for (const pkg of pkgs) {
      const { scanned, counts } = scanPackage(pkg, cfg);
      const n = Object.values(counts).reduce((a, b) => a + b, 0);
      total += n;
      if (!scanned) { console.error(`check-owner-literals --zero (${pkg}): scanned nothing — proves nothing`); process.exit(1); }
      if (n) {
        console.error(`check-owner-literals --zero (${pkg}): ${n} owner literal(s) in ${Object.keys(counts).length} file(s) —`);
        for (const [f, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.error(`  ${c}  ${f}`);
      } else console.log(`check-owner-literals --zero (${pkg}): ok — 0 (${scanned} scanned)`);
    }
    const clean = checkZeroPaths(cfg);
    process.exit(total || !clean ? 1 : 0);
  }
  for (const p of pkgs) {
    if (!cfg.packages.includes(p)) { console.error(`unknown package "${p}" — expected one of ${cfg.packages.join(", ")}`); process.exit(2); }
  }

  const { header, files } = readBaseline();
  let baseline = files;
  let failed = false;
  for (const pkg of pkgs) {
    const { scanned, counts } = scanPackage(pkg, cfg);
    if (update) {
      baseline = lowerBaseline(pkg, counts, baseline);
      writeBaseline(header, baseline);
    }
    const r = compare(pkg, counts, baseline);
    const bad = [...r.raised, ...r.added];
    const unlocked = update ? [] : [...r.lowered, ...r.stale];
    if (bad.length) {
      failed = true;
      console.error(`\ncheck-owner-literals (${pkg}): NEW owner literals —`);
      for (const e of r.added) console.error(`  ${e.path}: ${e.now} (a new file must have none)`);
      for (const e of r.raised) console.error(`  ${e.path}: ${e.base} → ${e.now}`);
      console.error("\nAn owner literal is a value that is THIS install's — the domain, the streamer's or");
      console.error("bot's names, channel ids, LAN addresses, the OBS scene names (tools/owner-literals.json).");
      console.error("Read it from config/env instead, or move owner-only code under an owner/ folder.");
      console.error("Comments count too: write \"the owner\", not a name. If the literal is genuinely right,");
      console.error("raise its entry in tools/owner-literals.baseline.json BY HAND, in this commit, and say why.");
    }
    if (unlocked.length) {
      failed = true;
      console.error(`\ncheck-owner-literals (${pkg}): counts went DOWN — lock the improvement in:`);
      for (const e of unlocked) console.error(`  ${e.path}: ${e.base} → ${e.now}`);
      console.error(`  node tools/check-owner-literals.mjs --update ${pkg}`);
      console.error("(A baseline above reality is slack the next change can quietly grow back into.)");
    }
    if (!bad.length && !unlocked.length) {
      console.log(`check-owner-literals (${pkg}): ok — ${r.total} in ${Object.keys(counts).length} files (${scanned} scanned)`);
    }
    // Ratchet patterns: each against its own ceilings (in its pattern file), tests included.
    const ratchetCounts = scanRatchets(pkg, cfg);
    if (update) lowerRatchets(pkg, cfg, ratchetCounts);
    const fresh = update ? loadConfig() : cfg;
    for (const p of fresh.patterns.filter((x) => x.ratchet)) {
      const rr = compare(pkg, ratchetCounts[p.name] ?? {}, p.ratchet ?? {});
      const up = [...rr.raised, ...rr.added];
      const down = update ? [] : [...rr.lowered, ...rr.stale];
      if (up.length) {
        failed = true;
        console.error(`\ncheck-owner-literals (${pkg}): "${p.name}" went UP — it may only go down:`);
        for (const e of rr.added) console.error(`  ${e.path}: ${e.now} (a file without a ceiling must have none)`);
        for (const e of rr.raised) console.error(`  ${e.path}: ${e.base} → ${e.now}`);
      }
      if (down.length) {
        failed = true;
        console.error(`\ncheck-owner-literals (${pkg}): "${p.name}" went DOWN — lock it in:`);
        for (const e of down) console.error(`  ${e.path}: ${e.base} → ${e.now}`);
        console.error(`  node tools/check-owner-literals.mjs --update ${pkg}`);
      }
      if (!up.length && !down.length) console.log(`check-owner-literals (${pkg}): "${p.name}" ratchet ok — ${rr.total} in ${Object.keys(ratchetCounts[p.name] ?? {}).length} files`);
    }
  }
  if (!update && !checkZeroPaths(cfg)) failed = true;
  if (failed) process.exit(1);
}
