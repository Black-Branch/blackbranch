// Run: node --test app/lib/htmlEntities.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeHtmlEntities } from "./htmlEntities.ts";

test("each entity decodes", () => {
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry &lt;3 &gt; &quot;hi&quot; it&#39;s it&#039;s it&apos;s"),
    `Tom & Jerry <3 > "hi" it's it's it's`);
});

test("decoding is one pass: an escaped entity comes out as the entity, not its character", () => {
  assert.equal(decodeHtmlEntities("a &amp;lt; b"), "a &lt; b");
  assert.equal(decodeHtmlEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeHtmlEntities("&amp;quot;&amp;#39;"), "&quot;&#39;");
});

test("anything else is left as written", () => {
  assert.equal(decodeHtmlEntities("&nbsp; &copy; & ; &#60;"), "&nbsp; &copy; & ; &#60;");
  assert.equal(decodeHtmlEntities(""), "");
});

test("the YouTube title and the link-preview scrape both decode through it", () => {
  // Each file's own last line anchors the read, so the negative check cannot pass over a short one.
  for (const [f, tail] of [
    ["./streamStatus.ts", /export const getStreamStatus = [^\n]*\n\s*$/],
    ["../api/og/route.ts", /return Response\.json\(null\);\n  \}\n\}\s*$/],
  ] as const) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, tail, `${f} read whole`);
    assert.match(src, /import \{ decodeHtmlEntities \} from "@\/app\/lib\/htmlEntities";/, `${f} imports the one decoder`);
    assert.match(src, /decodeHtmlEntities\(/, `${f} calls it`);
    assert.doesNotMatch(src, /\.replace\(\/&amp;\/g/, `${f} carries its own replace chain again`);
  }
});
