// The delegation documents are built from the matrix.* install config — these
// pin the exact JSON, and that the route handlers exist where Matrix clients look.
//
// Run: node --test app/lib/matrixWellKnown.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clientWellKnown, serverWellKnown, WELL_KNOWN_HEADERS } from "./matrixWellKnown.ts";
import { matrixFederationServer, matrixServerName, localMatrixId } from "./matrixConfig.ts";

test("client: homeserver + both authentication keys (stable and MSC2965), account when known", () => {
  assert.deepEqual(clientWellKnown("https://matrix.example.tv", "https://matrix.example.tv/auth/", "https://matrix.example.tv/auth/account/"), {
    "m.homeserver": { base_url: "https://matrix.example.tv" },
    "m.authentication": { issuer: "https://matrix.example.tv/auth/", account: "https://matrix.example.tv/auth/account/" },
    "org.matrix.msc2965.authentication": { issuer: "https://matrix.example.tv/auth/", account: "https://matrix.example.tv/auth/account/" },
  });
});

test("client: discovery down → account OMITTED (never guessed); the homeserver half stands", () => {
  const doc = clientWellKnown("https://matrix.example.tv", "https://matrix.example.tv/auth/", null);
  assert.deepEqual(doc["m.authentication"], { issuer: "https://matrix.example.tv/auth/" });
  assert.equal(doc["m.homeserver"].base_url, "https://matrix.example.tv");
});

test("server: m.server defaults to the homeserver host on 443, an explicit value wins", () => {
  assert.deepEqual(serverWellKnown(matrixFederationServer()), { "m.server": "matrix.example.tv:443" });
  assert.deepEqual(serverWellKnown("fed.example.tv:8448"), { "m.server": "fed.example.tv:8448" });
});

test("CORS + JSON on both (Matrix web clients fetch them cross-origin)", () => {
  assert.equal(WELL_KNOWN_HEADERS["Access-Control-Allow-Origin"], "*");
  assert.equal(WELL_KNOWN_HEADERS["Content-Type"], "application/json");
});

test("served by route handlers — and the static files are gone (they would shadow the routes)", () => {
  const web = process.cwd();
  for (const which of ["client", "server"]) {
    const route = join(web, "app/.well-known/matrix", which, "route.ts");
    assert.ok(existsSync(route), `${which} route handler missing`);
    assert.match(readFileSync(route, "utf8"), /export (async )?function GET/);
    assert.equal(existsSync(join(web, "public/.well-known/matrix", which)), false, `public/.well-known/matrix/${which} is back`);
  }
});

test("server name helpers", () => {
  assert.equal(matrixServerName(), "example.tv");
  assert.equal(localMatrixId("alice"), "@alice:example.tv");
  assert.equal(localMatrixId("@alice"), "@alice:example.tv");
});
