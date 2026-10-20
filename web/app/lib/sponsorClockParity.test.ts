// PARITY GUARD: web/app/lib/sponsorClockServer.ts ⇄ stream-api/sponsors.js's
// GET /sponsors/clock route.
//
// There is no shared import across this HTTP boundary — clockActiveFor()
// builds a request URL against a literal path string and reads two literal
// field names (`ok`, `active`) off whatever JSON comes back. Nothing stops a
// route rename or a response-field rename on the stream-api side from
// drifting out from under it: a 200 carrying valid-but-differently-shaped
// JSON (say `{ ok: true, lit: true }` instead of `{ ok: true, active: true }`)
// silently answers `false` — see sponsorClockServer.ts's own shape-check test
// for the loud-warning half. This file is the other half: it drives the REAL
// stream-api route handler (same harness as sponsors-route.test.js) and fails
// if the path or the field names it produces stop matching what the resolver
// expects.
//
// Run: node --test app/lib/sponsorClockParity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { createSponsors } = require("../../../stream-api/sponsors.js") as {
  createSponsors: (deps: {
    pool: unknown;
    broadcast: () => void;
    timer: { snapshot: () => unknown };
    getStreamId: () => Promise<string>;
  }) => {
    registerSponsorRoutes: (
      app: { get: (path: string, ...handlers: unknown[]) => void },
      deps: { requireInternal: unknown; wrap: (fn: unknown) => unknown }
    ) => void;
    __test: { state: Map<string, unknown> };
  };
};

// The literal path sponsorClockServer.ts's clockActiveFor() builds its request
// URL against: `` `/sponsors/clock?matrixId=${encodeURIComponent(matrixId)}` ``.
// Read straight out of the source text (not retyped by hand here) so this
// guard cannot itself drift from the resolver it is meant to pin.
const RESOLVER_SRC = readFileSync(join(HERE, "sponsorClockServer.ts"), "utf8");
const PATH_MATCH = RESOLVER_SRC.match(/`(\/[^`$]+)\?matrixId=/);
assert.ok(PATH_MATCH, "could not find the clock route's path literal in sponsorClockServer.ts — update this guard's extraction");
const EXPECTED_PATH = PATH_MATCH![1]!;

type FakeRoute = { middleware: unknown[]; handler: (req: unknown, res: unknown) => Promise<unknown> };
function fakeApp() {
  const routes: Record<string, FakeRoute> = {};
  return {
    routes,
    get: (path: string, ...h: unknown[]) => {
      routes[path] = { middleware: h.slice(0, -1), handler: h[h.length - 1] as FakeRoute["handler"] };
    },
    // POST /sponsors/links-changed (the show-links switch) registers alongside; not under test here.
    post: () => {},
  };
}
function fakeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
function poolWith(links: Record<string, string[]>) {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (/WHERE matrix_id = \$1/.test(sql)) {
        const id = params[0] as string;
        return { rows: (links[id] ?? []).map((cid) => ({ id: cid })) };
      }
      throw new Error(`sponsorClockParity: unexpected query against the fake pool: ${sql}`);
    },
  };
}

function harness(links: Record<string, string[]> = {}) {
  const sponsors = createSponsors({
    pool: poolWith(links),
    broadcast: () => {},
    timer: { snapshot: () => ({ night: { active: true, elapsedSec: 1000 }, usdPerHour: 0 }) },
    getStreamId: async () => "S1",
  });
  const app = fakeApp();
  sponsors.registerSponsorRoutes(app, {
    requireInternal: (_req: unknown, _res: unknown, next: () => void) => next(),
    wrap: (fn: unknown) => fn,
  });
  return { sponsors, app };
}

test("stream-api registers the route at the exact path the resolver requests", () => {
  const { app } = harness();
  assert.ok(
    app.routes[EXPECTED_PATH],
    `stream-api has no route at "${EXPECTED_PATH}" (found: ${Object.keys(app.routes).join(", ") || "none"}) — ` +
      "sponsorClockServer.ts's clockActiveFor() builds its request against this literal path; " +
      "a rename on either side strands the clock perk at 1x with no error anywhere."
  );
});

test("a lit clock answers exactly { ok: true, active: true } — the field names clockActiveFor reads", async () => {
  const { app, sponsors } = harness({ "@eddy:site.test": ["a60500127435"] });
  sponsors.__test.state.set("u:a60500127435", {
    name: "Gadget Qorm", aliases: new Map(), weightSec: 100,
    clockUntilElapsed: 1600, clockStartElapsed: 1000,
  });
  const res = fakeRes();
  await app.routes[EXPECTED_PATH]!.handler({ query: { matrixId: "@eddy:site.test" } }, res);

  const body = res.body as Record<string, unknown>;
  // clockActiveFor's exact read is `body.ok === true && body.active === true`
  // — assert the FIELD NAMES and TYPES, not just that a truthy body came
  // back, so a rename to e.g. `{ ok: true, lit: true }` fails this test even
  // though it is a "reasonable-looking" response.
  assert.equal(typeof body.ok, "boolean", "response is missing a boolean `ok` field");
  assert.equal(typeof body.active, "boolean", "response is missing a boolean `active` field — " +
    "this is the exact name web/app/lib/sponsorClockServer.ts's clockActiveFor() reads");
  assert.equal(body.ok, true);
  assert.equal(body.active, true, "a live pool entry did not answer active:true through the real route handler");
});

test("an inactive clock answers a present boolean active:false, not an absent field", async () => {
  const { app } = harness();
  const res = fakeRes();
  await app.routes[EXPECTED_PATH]!.handler({ query: { matrixId: "@nobody:site.test" } }, res);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.active, false);
});

// Vacuity anchor: prove the harness drives the REAL validation logic inside
// sponsors.js (not a stub that always answers ok), so the assertions above
// are pinned to the actual route handler rather than to this file's own
// fakes agreeing with themselves.
test("vacuity anchor — the real handler's own input validation still runs through this harness", async () => {
  const { app } = harness();
  const res = fakeRes();
  await app.routes[EXPECTED_PATH]!.handler({ query: { matrixId: "not-a-matrix-id" } }, res);
  assert.equal(res.statusCode, 400, "the real route's matrixId shape guard did not fire — " +
    "this harness may be exercising a stub instead of stream-api's actual handler");
  assert.deepEqual(res.body, { error: "bad matrixId" });
});
