import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./testSource.ts";

// ── matrix-js-sdk stays out of every route's first-load graph ────────────────
//
// The SDK is the heaviest dependency in the app (~700 KB raw / ~193 KB gz
// before crypto even loads), and the whole lazy-start design exists so nobody
// pays for it without Matrix intent: MatrixClientContext loads it via
// `await import`, and MatrixPanel / MatrixView / MatrixSettings /
// SecureAccountPromptInner are next/dynamic boundaries.
//
// One static VALUE import from the eager graph defeats all of that at once:
// a module importing { RoomEvent } for a single enum string can carry the SDK
// (via ChatSidebar → StreamView) into the home page and the OBS overlay chunk
// for every visitor — a large share of the home page's client-module gzip.
//
// An allowlist of value-importing FILES cannot catch that failure mode: each of
// the value importers outside features/community is legitimate where it
// sits, behind a dynamic boundary. The bug is REACHABILITY — an eager module
// statically importing one of them. So this test walks the real static import
// graph from every route root and fails on any path that reaches a value
// import of the SDK, printing the chain. Dynamic `import(...)` / next/dynamic
// are the sanctioned split points and are simply not edges here; `import type`
// is erased at compile and is not an edge either (matrixDisplay.ts documents
// that pattern — types are free, values are the bundle).

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..", "..");
const APP = join(WEB, "app");

// Route roots: everything Next mounts eagerly for a URL. API routes and the
// metadata files (robots/sitemap/og-image) are server-only and out of scope —
// this is a claim about the client bundle.
const ROOT_RE = /^(page|layout|template|error|global-error|not-found)\.tsx$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const srcCache = new Map<string, string>();
function src(abs: string): string {
  let s = srcCache.get(abs);
  if (s === undefined) {
    s = stripComments(readFileSync(abs, "utf8"));
    srcCache.set(abs, s);
  }
  return s;
}

// Static import/export-from statements. The specifier clause of a real import
// never contains parens, quotes or semicolons, which is what keeps this from
// matching dynamic `import("…")` (paren right after the keyword) or wandering
// across statements. Bare side-effect imports are matched separately.
const STMT = /\b(import|export)\s+([^;()'"`]*?)from\s*["']([^"']+)["']/g;
const BARE = /\bimport\s*["']([^"']+)["']/g;

/** Static edges out of a file: [spec, isTypeOnly]. */
function staticImports(abs: string): Array<{ spec: string; typeOnly: boolean }> {
  const s = src(abs);
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  for (const m of s.matchAll(STMT)) {
    out.push({ spec: m[3]!, typeOnly: /^type\b/.test(m[2]!.trim()) });
  }
  for (const m of s.matchAll(BARE)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** True when the file VALUE-imports matrix-js-sdk (any subpath) statically. */
function valueImportsSdk(abs: string): boolean {
  return staticImports(abs).some(
    (i) => !i.typeOnly && /^matrix-js-sdk(\/|$)/.test(i.spec),
  );
}

/** In-repo module resolution for the two spec shapes the codebase uses. */
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(WEB, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // a package — never traversed, only matched by valueImportsSdk
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(cand) && existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null; // css / images / .mjs — not part of this graph
}

const rel = (abs: string) => relative(WEB, abs).split("\\").join("/");

test("no route's static import graph reaches a matrix-js-sdk value import", () => {
  const all = sourceFiles(APP);
  const roots = all.filter((f) => ROOT_RE.test(f.slice(f.lastIndexOf("/") + 1)));

  // Vacuity anchors, both directions: the negative
  // assertion below goes green over a hole if the roots vanish, the walk stops
  // early, or the detector rots — so each is pinned on something real first.
  assert.ok(roots.length >= 15, `only ${roots.length} route roots found — walker broken?`);
  const sdkImporters = all.filter(valueImportsSdk).map(rel);
  assert.ok(
    // MatrixView's own value import went with its DM code to app/lib/matrixDm.ts (type-only there, step 4b); the Timeline keeps one.
    sdkImporters.length >= 5 && sdkImporters.includes("app/features/community/Timeline.tsx"),
    `SDK value-import detector found ${sdkImporters.length} importers — detector broken?`,
  );

  // BFS over static, value-carrying edges; parents kept for the chain message.
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!parent.has(r)) {
      parent.set(r, null);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const f = queue.shift()!;
    for (const i of staticImports(f)) {
      if (i.typeOnly) continue;
      const target = resolveSpec(f, i.spec);
      if (target === null || parent.has(target)) continue;
      parent.set(target, f);
      queue.push(target);
    }
  }

  // The traversal must actually be walking the deep eager graph, or the
  // assertion below is a claim about an empty set.
  for (const mustReach of [
    "app/features/chat/ChatSidebar.tsx",
    "app/lib/useChatSplitView.ts",
    "app/lib/MatrixClientContext.tsx",
  ]) {
    assert.ok(
      [...parent.keys()].some((f) => rel(f) === mustReach),
      `${mustReach} is no longer reachable from any route root — traversal broken (or the file moved; update this anchor)`,
    );
  }

  const chains = [...parent.keys()]
    .filter(valueImportsSdk)
    .map((abs) => {
      const chain: string[] = [];
      for (let f: string | null = abs; f !== null; f = parent.get(f) ?? null) chain.unshift(rel(f));
      return chain.join("\n    → ");
    });
  assert.deepEqual(
    chains,
    [],
    `matrix-js-sdk is statically reachable from a route root — it will ship in that ` +
      `route's first-load JS. Break the chain with a type-only import + literal ` +
      `(matrixDisplay.ts / useChatSplitView.ts show the pattern) or a dynamic ` +
      `boundary. Chains:\n  ${chains.join("\n  ")}`,
  );
});

test("MatrixClientContext loads the SDK only through dynamic import", () => {
  // The context is mounted in the root layout for every visitor — it is the one
  // file where "just import it" would be both most tempting and most expensive.
  const ctx = join(APP, "lib", "MatrixClientContext.tsx");
  assert.ok(valueImportsSdk(ctx) === false, "MatrixClientContext must not static-import the SDK");
  assert.match(src(ctx), /import\(\s*["']matrix-js-sdk["']\s*\)/, "…and must still load it dynamically");
});
