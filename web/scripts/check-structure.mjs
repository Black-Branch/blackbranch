#!/usr/bin/env node
// Dependency-direction guard (north-star invariant 1).
//
// The architecture blueprint calls this "the single rule that stops entropy from
// growing back while we work". It was deferred once, to ride a feature
// extraction that is no longer planned — so it lands here instead, enforced
// against the CURRENT flat structure rather than waiting on a folder move.
//
// Four rules, all currently at ZERO violations:
//
//   1. CORE MUST NOT IMPORT UI.  app/lib/** and lib/** may not import
//      app/components/**. Core is what features are built ON; the moment core
//      reaches back into a component, that component can never be removed,
//      replaced, or extracted without breaking everything beneath it. This was
//      violated 5 times and is now 0 (the types moved into core, where they
//      already belonged; the components re-export them so callers are unchanged).
//
//   2. NO RUNTIME IMPORT CYCLES.  A cyclic graph has no direction, so rule 1
//      becomes unverifiable in the general case. Two cycles existed in the emote
//      subsystem; extracting lib/emoteMap.ts removed them for real rather than
//      exempting them.
//
//   3. FEATURES ARE REACHABLE ONLY THROUGH THEIR PUBLIC API. Anything outside
//      app/features/<x>/ imports that folder's index.ts, never a file inside it.
//      A feature you can reach into is a feature you can never replace. This
//      also subsumes cross-feature isolation: A reaching into B's internals is
//      just a special case of reaching past an index.
//
//   4. CORE MUST NOT DEPEND ON FEATURES AT ALL — not even through the public
//      API. If core imports a feature, deleting that feature breaks core, and
//      "delete the folder and the app still builds" can never pass.
//
// `import type` COUNTS as an edge for rule 1 and NOT for rule 2, which is not an
// inconsistency — the two rules ask different questions:
//   • rule 1 asks "can this be extracted?" — a core module typed against a
//     component's internals still cannot be, so type edges count. Ignoring them
//     is how all five original violations survived review.
//   • rule 2 asks "can this deadlock/misorder at load time?" — a loop containing
//     a type-only edge does not exist in the emitted JS, so it cannot. Those are
//     reported as warnings, because the hygiene is worth seeing but refactoring
//     the prepaint-critical settingsRegistry to satisfy a graph property would
//     be a bad trade.
//
// Run: node scripts/check-structure.mjs   (exit 1 on violation)
// Analysis this encodes: the design-system step 2 plan, sibling work.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["app", "lib", "types"];

const files = [];
function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p);
  }
}
for (const r of ROOTS) {
  try { walk(join(WEB, r)); } catch { /* optional root */ }
}

const rel = (p) => relative(WEB, p);
const graph = new Map();

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const deps = [];
  // Matches `import … from "x"` including `import type`, and `export … from "x"`
  // (a re-export is a dependency too — the whole re-export trick this codebase
  // now uses would otherwise hide edges from this check).
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)(\s+type)?\s[^;]*?from\s+["']([^"']+)["']/g)) {
    const spec = m[2];
    // `import type X` / `export type X` — and the inline `{ type Foo }` form when
    // EVERY named binding is a type. Type-only edges erase at build, so they
    // cannot form a runtime cycle, but they are still real declaration coupling.
    const clause = m[0];
    const typeOnly =
      Boolean(m[1]) ||
      (/\{[^}]*\}/.test(clause) &&
        clause
          .slice(clause.indexOf("{") + 1, clause.indexOf("}"))
          .split(",")
          .filter((s) => s.trim())
          .every((s) => /^\s*type\s/.test(s)));
    if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
    // tsconfig paths: "@/*" -> "./*" from the web/ root
    const base = spec.startsWith("@/")
      ? join(WEB, spec.slice(2)).replace(/\.(tsx?|js)$/, "")
      : resolve(dirname(f), spec).replace(/\.(tsx?|js)$/, "");
    const hit = [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]
      .find((c) => files.includes(c));
    if (hit) deps.push({ to: rel(hit), typeOnly });
  }
  graph.set(rel(f), deps);
}

const isCore = (p) => p.startsWith("app/lib/") || p.startsWith("lib/");
const isUI = (p) => p.startsWith("app/components/");

/** `app/features/<name>/…` -> "<name>", else null. */
const featureOf = (p) => {
  const m = /^app\/features\/([^/]+)\//.exec(p);
  return m ? m[1] : null;
};
/** The feature's public API — the only file outsiders may import. */
const isFeatureEntry = (p) => /^app\/features\/[^/]+\/index\.tsx?$/.test(p);

// ── rule 1: core must not import UI ──────────────────────────────────────────
const layer = [];
for (const [f, deps] of graph) {
  if (!isCore(f)) continue;
  // Type-only edges COUNT here: a core module typed against a component's
  // internals is still core depending on UI, and it still blocks extraction.
  for (const d of deps) if (isUI(d.to)) layer.push(`${f}  ->  ${d.to}${d.typeOnly ? "  (type-only, but still coupling)" : ""}`);
}

// ── rule 3: features are reachable only through their public API ─────────────
// A feature you can reach into is a feature you can never replace: every file
// inside it becomes load-bearing the moment something names it. Importing the
// folder's index.ts keeps the inside free to be rewritten, split or renamed.
// This also subsumes cross-feature isolation — feature A reaching into feature
// B's internals is just a special case of reaching past an index.
const encapsulation = [];
for (const [f, deps] of graph) {
  const fromFeature = featureOf(f);
  for (const d of deps) {
    const toFeature = featureOf(d.to);
    if (!toFeature) continue;
    if (toFeature === fromFeature) continue;      // inside its own folder: fine
    if (isFeatureEntry(d.to)) continue;           // through the public API: fine
    encapsulation.push(
      `${f}  ->  ${d.to}` +
        (fromFeature ? `   [feature "${fromFeature}" reaching into "${toFeature}"]` : "")
    );
  }
}

// ── rule 4: core must not depend on features at all ──────────────────────────
// Not even through the public API. Core is what features are built ON; if core
// imports a feature, deleting that feature breaks core, and the "delete the
// folder and it still builds" test can never pass.
const coreToFeature = [];
for (const [f, deps] of graph) {
  if (!isCore(f)) continue;
  for (const d of deps) if (featureOf(d.to)) coreToFeature.push(`${f}  ->  ${d.to}`);
}

// ── rule 2: no cycles ────────────────────────────────────────────────────────
const cycles = [];
const state = new Map();
const stack = [];
(function findCycles() {
  function dfs(n) {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) {
      const i = stack.indexOf(n);
      if (i >= 0) cycles.push([...stack.slice(i), n]);
      return;
    }
    state.set(n, 1);
    stack.push(n);
    for (const d of graph.get(n) ?? []) dfs(d.to);
    stack.pop();
    state.set(n, 2);
  }
  for (const f of graph.keys()) dfs(f);
})();

let failed = false;
if (layer.length) {
  failed = true;
  console.error(`✗ dependency direction: ${layer.length} core->UI import(s)\n  ` + layer.join("\n  "));
  console.error(
    "\n  → core must not import app/components/**. Usually the fix is that a TYPE or\n" +
    "    CONSTANT is defined in the component and belongs in core: move the definition\n" +
    "    into app/lib/ and re-export it from the component so callers are unchanged.\n"
  );
}
// A cycle is a RUNTIME cycle only if every edge in it survives to runtime. If any
// edge is type-only the loop does not exist in the emitted JS — that is hygiene
// worth seeing, not a build-breaking defect. Refactoring the prepaint-critical
// settingsRegistry to satisfy a graph property would be a bad trade.
const edgeIsTypeOnly = (from, to) =>
  (graph.get(from) ?? []).find((d) => d.to === to)?.typeOnly ?? false;
const runtimeCycles = [];
const typeCycles = [];
for (const c of cycles) {
  let allRuntime = true;
  for (let i = 0; i < c.length - 1; i++) if (edgeIsTypeOnly(c[i], c[i + 1])) allRuntime = false;
  (allRuntime ? runtimeCycles : typeCycles).push(c);
}

if (encapsulation.length) {
  failed = true;
  console.error(`✗ feature encapsulation: ${encapsulation.length} import(s) past a feature's public API\n  ` + encapsulation.join("\n  "));
  console.error(
    "\n  → import the feature's folder (its index.ts), not a file inside it. If the\n" +
    "    thing you need is not exported there, decide deliberately whether it is\n" +
    "    part of the feature's API — or whether it is actually shared vocabulary\n" +
    "    that belongs in app/lib/ instead (see coins.ts).\n"
  );
}
if (coreToFeature.length) {
  failed = true;
  console.error(`✗ core depends on a feature: ${coreToFeature.length}\n  ` + coreToFeature.join("\n  "));
  console.error(
    "\n  → core must not import app/features/** at all, not even a public API.\n" +
    "    Otherwise deleting the feature breaks core and it stops being optional.\n"
  );
}
if (runtimeCycles.length) {
  failed = true;
  console.error(`✗ RUNTIME import cycles: ${runtimeCycles.length}`);
  for (const c of runtimeCycles.slice(0, 10)) console.error("  " + c.join(" -> "));
  console.error(
    "\n  → break the cycle by extracting what both ends share (usually a type) into\n" +
    "    its own core module.\n"
  );
}
if (typeCycles.length) {
  console.log(`⚠ ${typeCycles.length} type-only cycle(s) — erased at build, no runtime loop:`);
  for (const c of typeCycles.slice(0, 5)) console.log("    " + c.join(" -> "));
}
if (failed) process.exit(1);

const edges = [...graph.values()].reduce((a, b) => a + b.length, 0);
const featureNames = [...new Set([...graph.keys()].map(featureOf).filter(Boolean))];
console.log(
  `✓ structure: ${graph.size} modules, ${edges} edges, ` +
    `0 runtime cycles, 0 core->UI imports, ` +
    `${featureNames.length} feature(s) encapsulated${featureNames.length ? ` [${featureNames.join(", ")}]` : ""}` +
    (typeCycles.length ? ` (${typeCycles.length} type-only cycle(s) noted above)` : "")
);
