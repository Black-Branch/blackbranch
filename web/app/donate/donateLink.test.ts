import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the site's own tip link falls back to our page, not a third party", () => {
  const src = readFileSync(new URL("../(main)/page.tsx", import.meta.url), "utf8");
  assert.ok(
    /donateUrl=\{process\.env\.DONATE_URL \?\? "\/donate"\}/.test(src),
    "the DONATE_URL fallback must be our own /donate page",
  );
  assert.ok(!/streamlabs\.com/.test(src), "no third-party tip link remains in the fallback");
});
