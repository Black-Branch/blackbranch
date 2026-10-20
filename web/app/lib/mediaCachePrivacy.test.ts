import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

// The Matrix media proxy attaches the VIEWER's access token upstream, so what it
// returns is that viewer's to see — a private room's image included. A `public`
// Cache-Control lets any shared cache in front of the site (Cloudflare caches by
// file extension, and a download path may end in `name.png`) hand one person's
// private media to the next requester, who never presented a token at all.
const src = stripComments(readFileSync(new URL("../api/matrix/media/[...path]/route.ts", import.meta.url), "utf8"));

test("token-authenticated Matrix media is never publicly cacheable", () => {
  const headers = [...src.matchAll(/"Cache-Control":\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
  assert.ok(headers.length >= 1, "the success headers set a Cache-Control");
  // Every success response is a relay built from those one set of headers.
  const relays = [...src.matchAll(/relayMedia\(\w+, \{[^}]*headers: (\w+)\(/g)].map((m) => m[1]);
  assert.ok(relays.length >= 2, "both success paths (first try + token refresh) relay the body");
  for (const r of relays) assert.equal(r, "mediaHeaders");
  for (const h of headers) {
    assert.match(h, /^private\b/, `"${h}" must start with private`);
    assert.doesNotMatch(h, /\bpublic\b/);
  }
  // vacuity anchor: the scan reached the end of the handler
  assert.match(src, /return new Response\(null, \{ status: 404 \}\);\s*\}\s*$/);
});
