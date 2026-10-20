// The Matrix media proxy route: every relayed body takes its headers from ONE builder, which holds
// the type to the allowlist and sends Content-Disposition with it. Source scan — the route imports
// through the @/ alias, which node --test cannot resolve; the allowlist itself is run in
// app/lib/mediaHeaders.test.ts and the delivered CSP is checked in app/lib/mediaProxyCsp.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("END anchor: the route was read to its last line", () => {
  assert.match(raw, /return new Response\(null, \{ status: 404 \}\);\n\}\n$/);
});

test("the header builder derives type AND disposition from the upstream response", () => {
  assert.match(src, /const mediaHeaders = \(upstream: Response\): Record<string, string> => \{/);
  assert.match(src, /const contentType = proxiedContentType\(upstream\.headers\.get\("content-type"\), "image\/jpeg"\);/);
  assert.match(src, /const disposition = mediaDisposition\(contentType, upstream\.headers\.get\("content-disposition"\)\);/);
  assert.match(src, /\.\.\.\(disposition \? \{ "Content-Disposition": disposition \} : \{\}\)/);
  assert.match(src, /\.\.\.MEDIA_SAFETY_HEADERS,/);
});

test("both relays use the builder, and no other path picks a type", () => {
  const relays = src.match(/relayMedia\(\w+, \{\s*maxBytes: MEDIA_MAX_BYTES, headers: [^,]+,/g) ?? [];
  assert.equal(relays.length, 2);
  assert.match(relays[0]!, /headers: mediaHeaders\(retry\),/);
  assert.match(relays[1]!, /headers: mediaHeaders\(upstream\),/);
  assert.equal(src.match(/proxiedContentType\(/g)?.length, 1);
});
