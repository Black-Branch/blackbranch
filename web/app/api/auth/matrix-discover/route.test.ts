// Source scan: matrix-discover's answer comes ONLY from discoverIssuer (federatedSignIn.ts), which
// runs the openid-configuration fallback through parseAuthMetadata too — tested there with a
// `javascript:` endpoint. The route never returns the fallback document's endpoints unvalidated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("the endpoints the route returns come from the validated discovery, never a raw document", () => {
  assert.match(src, /discoverIssuer\(homeserver, wellKnown, /);
  assert.doesNotMatch(src, /oidcConfig\.|\.authorization_endpoint|openid-configuration/);
  assert.match(src, /authorizationEndpoint: md\.authorizationEndpoint/);
  assert.match(src, /\}\s*$/); // END anchor
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-1)));
});
