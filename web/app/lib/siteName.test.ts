// Run: node --test app/lib/siteName.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "./testInstallValues.ts";
import { siteName } from "./siteName.ts";
import { installValue } from "./installValues.ts";

test("siteName() is the site.name published at boot — no default of its own, and not re-read per call", () => {
  // The name is an install value (SITE_NAME, alias NEXT_PUBLIC_SITE_NAME) resolved from the
  // environment ONCE, when the server starts (instrumentation.ts → installValuesServer.ts), which
  // refuses to boot without it — so there is no fallback to fall back to, and an env var changed
  // in a running process is not this install's name until the next start.
  const before = process.env.NEXT_PUBLIC_SITE_NAME;
  try {
    process.env.NEXT_PUBLIC_SITE_NAME = "Another Stream";
    assert.equal(siteName(), "Example Stream");
    assert.equal(siteName(), installValue("site.name"));
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_SITE_NAME;
    else process.env.NEXT_PUBLIC_SITE_NAME = before;
  }
});
