// CSP guard for the PayPal button. script-src is a strict allowlist, so
// without these origins the PayPal SDK silently never loads and the button
// simply is not there — no error, no crash, just an empty block. Pins the
// exact origins so a future CSP edit cannot quietly remove them.
//
// The policy is written once, in app/lib/csp.ts (the proxy sends it with the
// install's origins, next.config.ts without them on files), so this reads that file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const raw = readFileSync(new URL("./csp.ts", import.meta.url), "utf8");
const src = stripComments(raw);

test("vacuity anchor: csp.ts is read whole and its CSP carries a known existing origin", () => {
  assert.ok(/\]\.join\("; "\);\s*\}\s*$/.test(raw), "csp.ts truncated — pins below are vacuous");
  assert.ok(src.includes("https://js.stripe.com"), "a known existing CSP origin (js.stripe.com) is missing — the scan may be targeting the wrong text");
});

function directive(name: string): string {
  const re = new RegExp(`"${name}[^"]*"`);
  const m = re.exec(src);
  assert.ok(m, `no ${name} directive string literal found in the CSP`);
  return m[0];
}

/** The directive's sources as tokens, so an origin is matched whole (never a prefix of a longer host). */
const sources = (name: string): string[] => directive(name).slice(1, -1).split(/\s+/);

test("script-src allows the PayPal SDK host and its objects host", () => {
  const d = sources("script-src");
  assert.ok(d.includes("https://www.paypal.com"), "script-src missing https://www.paypal.com — the SDK script tag would be blocked and the button simply would not appear");
  assert.ok(d.includes("https://www.paypalobjects.com"), "script-src missing https://www.paypalobjects.com");
});

test("form-action is 'self': no form may post a viewer's input to another origin", async () => {
  assert.equal(directive("form-action"), `"form-action 'self'"`);
  const { contentSecurityPolicy } = await import("./csp.ts");
  for (const p of [contentSecurityPolicy(), contentSecurityPolicy({ api: "https://api.example.tv" })]) {
    assert.ok(p.split("; ").includes("form-action 'self'"), "both the page and the file policy carry it");
  }
});

test("frame-src allows BOTH the live and sandbox PayPal hosts", () => {
  const d = sources("frame-src");
  assert.ok(d.includes("https://www.paypal.com"), "frame-src missing https://www.paypal.com");
  // The button renders inside a www.sandbox.paypal.com iframe under
  // sandbox credentials — the environment it is verified in — so
  // omitting this would make the button invisible in the only place it can
  // be tested.
  assert.ok(d.includes("https://www.sandbox.paypal.com"), "frame-src missing https://www.sandbox.paypal.com — the button renders in this iframe under sandbox credentials, so omitting it makes the button invisible in the only place it can be tested");
});
