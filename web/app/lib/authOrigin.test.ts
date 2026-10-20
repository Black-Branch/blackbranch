import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import "./testInstallValues.ts";
import { authOrigin } from "./authOrigin.ts";
// Loaded at run time: the box's site build typechecks tests, and tools/ is not in a release.
type Literals = { loadConfig: () => { patterns: { name: string; re: string }[] }; countLiterals: (text: string, cfg: unknown) => number };
const { loadConfig, countLiterals } = (await import(new URL("../../../tools/check-owner-literals.mjs", import.meta.url).href)) as Literals;

test("authOrigin is the site.origin published at boot — AUTH_URL changed later does not move it", () => {
  // The origin is an install value resolved from env ONCE, when the server starts
  // (installValuesServer.ts; applyAuthUrl then hands it to next-auth). A per-call read of the
  // env would let a later change split sign-in from every other address the site builds.
  const prior = process.env.AUTH_URL;
  try {
    process.env.AUTH_URL = "http://localhost:3002/";
    assert.equal(authOrigin(), "https://example.tv");
  } finally {
    if (prior === undefined) delete process.env.AUTH_URL;
    else process.env.AUTH_URL = prior;
  }
});

// ── The guard that matters ────────────────────────────────────────────────
// Cycle 7 made every `redirect_uri` derive from AUTH_URL and left five
// `const BASE_URL = "https://site.test"` behind, so a dev sign-in completed
// against the LIVE site and died there ("Sign-in link expired or already
// used"). A behavioural test of authOrigin() cannot catch that: the defect is
// a second file declining to call it. So scan the auth surface for any
// re-hardcoded origin.
const AUTH_DIR = new URL("../api/auth/", import.meta.url);
const routeFiles = readdirSync(AUTH_DIR, { recursive: true, encoding: "utf8" })
  .filter((p) => p.endsWith("route.ts"))
  .map((p) => ({ path: p, src: readFileSync(new URL(p, AUTH_DIR), "utf8") }));

test("no auth route hardcodes the site's own origin — all of them ask authOrigin()", () => {
  // Vacuity anchors: a scan whose assertions are all negative goes green over
  // an empty list or a moved directory. Pin the floor AND one positive fact.
  assert.ok(routeFiles.length >= 7, `expected the auth route surface, found ${routeFiles.length} files`);
  assert.ok(
    routeFiles.some((f) => f.path.includes("mas-callback")),
    "the MAS callback — a sign-in path that builds a redirect from the request — must be in the scan"
  );

  // A hardcoded origin is an install literal: the literal gate's patterns (the owner's domain, in a
  // tree that has the owner's pattern file) find it.
  const literals = loadConfig();
  for (const { path, src } of routeFiles) {
    const offending = src
      .split("\n")
      .filter((line) => /["'`]https:\/\//.test(line) && countLiterals(line, literals) > 0)
      // `client_uri` is OAuth client METADATA — it names the application to a
      // foreign homeserver during dynamic registration and is not a redirect,
      // so it stays the production URL even in dev.
      .filter((line) => !line.includes("client_uri"));
    assert.deepEqual(offending, [], `${path} hardcodes the site origin; call authOrigin() instead`);
  }
});

test("every route that redirects derives its origin from the shared helper", () => {
  const redirectors = routeFiles.filter(({ src }) => /NextResponse\.redirect|REDIRECT_URI|BASE_URL/.test(src));
  assert.ok(redirectors.length >= 5, `expected the redirecting routes, found ${redirectors.length}`);
  for (const { path, src } of redirectors) {
    // `assert.ok` rather than `assert.match`: a failed match prints the entire
    // route file into the test output, which buries the one line that matters.
    assert.ok(/authOrigin\(\)/.test(src), `${path} redirects but never asks authOrigin() where it lives`);
  }
});
