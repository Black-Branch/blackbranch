// The panel pages (/mod, /mod/chat, /admin/<section>) send a visitor who may not see them
// home from the SERVER, before anything renders. Next streams a route's loading.tsx as
// soon as the request arrives, so a loading boundary at or above a gated page turns its
// redirect() into a 200 that paints the skeleton and only then navigates. No gated panel
// page has a loading boundary, so each answers 307.
//
// Run: node --test app/lib/panelGateRedirect.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const main = join(webRoot, "app/(main)");

const GATED = [
  { page: "mod/page.tsx", gate: /if \(!\(await isModUser\(\)\)\) redirect\("\/"\);/ },
  { page: "mod/chat/page.tsx", gate: /if \(!\(await isModUser\(\)\)\) redirect\("\/"\);/ },
  { page: "admin/[section]/page.tsx", gate: /if \(!\(await requireAdmin\(\)\)\) redirect\("\/"\);/ },
];

test("each gated panel page checks on the server and redirects before it returns anything", () => {
  for (const { page, gate } of GATED) {
    const src = stripComments(readFileSync(join(main, page), "utf8"));
    const at = src.search(gate);
    assert.ok(at >= 0, `${page} lost its server-side gate`);
    assert.ok(at < src.indexOf("return "), `${page} must redirect before its first return`);
  }
});

function loadingFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...loadingFiles(p));
    else if (/^loading\.(tsx|ts|jsx|js)$/.test(name)) out.push(relative(main, p));
  }
  return out;
}

test("no loading boundary sits at or above a gated panel page", () => {
  const scanned: string[] = [];
  for (const { page } of GATED) {
    const segments = dirname(page).split("/");
    // app/(main)/loading.tsx itself, then every segment down to the page's own folder.
    for (let i = 0; i <= segments.length; i++) {
      const dir = join(main, ...segments.slice(0, i));
      scanned.push(dir);
      for (const ext of ["tsx", "ts", "jsx", "js"]) {
        assert.ok(!existsSync(join(dir, `loading.${ext}`)),
          `${relative(webRoot, join(dir, `loading.${ext}`))} would stream before ${page}'s redirect — a signed-out visitor sees it first`);
      }
    }
  }
  assert.ok(scanned.length >= 7, "the walk visited every folder above the three pages");
  // And none further down either, where a sub-route of a gated area would repeat the flash.
  for (const area of ["mod", "admin"]) assert.deepEqual(loadingFiles(join(main, area)), [], `a loading file under ${area}/`);
});
