#!/usr/bin/env node
// The owner seam gate.
//
// Each package has ONE file that may reach its owner folder — the seam. Everything else in the
// package is product, and product must build and run with the owner folder deleted (the public
// export). So: no file outside the owner root may import, require or URL-resolve a path inside it,
// except the seam. An owner file importing product code is fine; that edge points the right way.
//
// Comments are stripped first: a mention of `owner/` in prose is not an import (the inverse of
// check-owner-literals, which counts comments on purpose). Vacuity anchor: the seam itself must
// be found and must import the owner root — a scan that read nothing would otherwise pass.
//
// Usage: node tools/check-owner-seam.mjs <package>

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../web/app/lib/sourceText.mjs";

export const REPO = resolve(fileURLToPath(import.meta.url), "../..");

const OWNER_ROOTS = JSON.parse(readFileSync(join(REPO, "tools", "literals.json"), "utf8")).ownerRoots.paths;

/**
 * Per package: the seam — the file (or, ending in "/", the folder) that reads the plugin — and,
 * for web, the build config that
 * resolves `@owner/plugin` to the folder or to the empty plugin (with an existence check, so a
 * missing folder is not an error there either). Repo-relative.
 */
export const SEAMS = {
  "stream-api": { seam: "stream-api/plugins.js", resolvers: [] },
  "stream-ingest": { seam: "stream-ingest/index.js", resolvers: [] },
  // web's seam is a FOLDER: one small reader per contribution area (installed.ts, player.ts, …),
  // so a page bundles only the owner areas it reads.
  web: { seam: "web/app/lib/plugins/", resolvers: ["web/next.config.ts"] },
};

/** @param {string} pkg */
export function ownerRootOf(pkg) {
  const root = OWNER_ROOTS.find((r) => r.startsWith(`${pkg}/`));
  if (!root) throw new Error(`no owner root for ${pkg} in tools/literals.json`);
  return root;
}

const CODE = /\.(c|m)?(j|t)sx?$/;

// This gate's own fixtures: strings shaped like owner imports, by design. Nothing else is exempt.
const FIXTURES = new Set(["stream-api/owner-seam-gate.test.mjs"]);

// Every module specifier a file names: import/export … from, bare import, dynamic import,
// require(), and `new URL('…', import.meta.url)` (how stream-ingest finds its plugin) — plus ANY
// string literal that is a relative path, so `path.join(dir, './owner/x.js')` or a computed
// require counts too: a path into the owner folder is a dependency on it however it is spelled.
const SPECIFIER = [
  /(['"`])(\.\.?\/[^'"`\s]*)\1/g,
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  /\bnew\s+URL\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url/g,
];

/** @param {string} src  comments already stripped */
export function specifiersOf(src) {
  const out = [];
  for (const re of SPECIFIER) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[2]);
  }
  return [...new Set(out)];
}

/**
 * Where a specifier points, repo-relative, or null for a package import. web's `@/` alias is the
 * web root; `@owner/…` IS the owner root (it resolves there when the folder exists).
 * @param {string} spec
 * @param {string} file  repo-relative
 */
export function targetOf(spec, file) {
  if (spec.startsWith("@owner/")) return "@owner";
  if (spec.startsWith("@/")) return join("web", spec.slice(2));
  if (spec.startsWith("./") || spec.startsWith("../")) return relative(REPO, resolve(REPO, dirname(file), spec));
  return null;
}

/**
 * @param {string} pkg
 * @param {{ path: string, text: string }[]} files  repo-relative paths with their source
 * @returns {{ violations: { path: string, spec: string }[], seamImports: number, seamRead: boolean }}
 */
export function checkSeam(pkg, files) {
  const root = ownerRootOf(pkg);
  const { seam, resolvers } = SEAMS[pkg];
  const violations = [];
  let seamImports = 0;
  let seamRead = false;
  const isSeam = (p) => (seam.endsWith("/") ? p.startsWith(seam) : p === seam);
  for (const { path, text } of files) {
    if (path.startsWith(root) || !CODE.test(path) || FIXTURES.has(path)) continue;
    if (isSeam(path)) seamRead = true;
    for (const spec of specifiersOf(stripComments(text))) {
      const t = targetOf(spec, path);
      if (t === null) continue;
      const intoOwner = t === "@owner" || `${t}/`.startsWith(root) || t === root.replace(/\/$/, "");
      if (!intoOwner) continue;
      if (isSeam(path)) seamImports++;
      else if (!resolvers.includes(path)) violations.push({ path, spec });
    }
  }
  return { violations, seamImports, seamRead };
}

/** Tracked + untracked-not-ignored files of a package, as check-owner-literals lists them. */
function listFiles(pkg) {
  const out = execFileSync(
    "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `${pkg}/`],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter((p) => CODE.test(p) && !p.includes("/node_modules/") && existsSync(join(REPO, p)))
    .map((p) => ({ path: p, text: readFileSync(join(REPO, p), "utf8") }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = process.argv[2];
  if (!SEAMS[pkg]) {
    console.error(`usage: node tools/check-owner-seam.mjs <${Object.keys(SEAMS).join(" | ")}>`);
    process.exit(2);
  }
  const files = listFiles(pkg);
  const r = checkSeam(pkg, files);
  let failed = false;
  if (!r.seamRead || r.seamImports === 0) {
    failed = true;
    console.error(`check-owner-seam (${pkg}): the seam ${SEAMS[pkg].seam} was ${r.seamRead ? "read but imports nothing from" : "not found next to"} ${ownerRootOf(pkg)} — the scan proves nothing without it.`);
  }
  if (r.violations.length) {
    failed = true;
    console.error(`\ncheck-owner-seam (${pkg}): product code reaches into ${ownerRootOf(pkg)} —`);
    for (const v of r.violations) console.error(`  ${v.path}: ${v.spec}`);
    console.error(`\nOnly ${SEAMS[pkg].seam} may. Read the plugin's contribution through it instead, so the`);
    console.error("product still builds and runs when the owner folder is deleted (the public export).");
  }
  if (failed) process.exit(1);
  console.log(`check-owner-seam (${pkg}): ok — ${files.length} files, ${r.seamImports} seam import(s)`);
}
