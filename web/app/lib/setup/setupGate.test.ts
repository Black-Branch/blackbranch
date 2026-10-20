// First boot's gate: closed only on a positive reading, open otherwise.
// Run: node --test app/lib/setup/setupGate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupGateState, gateAction, setupPathOpen } from "./setupGate.ts";

test("the state: complete when finished, setting-up only when loaded + unset + a setup link exists", () => {
  assert.equal(setupGateState({ loaded: true, completedAt: "2026-10-10T00:00:00Z", tokenConfigured: true }), "complete");
  assert.equal(setupGateState({ loaded: true, completedAt: null, tokenConfigured: true }), "setting-up");
  // The settings could not be read: fail OPEN.
  assert.equal(setupGateState({ loaded: false, completedAt: null, tokenConfigured: true }), "unknown");
  // No setup link (the owner's install, a source checkout): never gated, whatever else is true.
  assert.equal(setupGateState({ loaded: true, completedAt: null, tokenConfigured: false }), "complete");
  assert.equal(setupGateState({ loaded: false, completedAt: null, tokenConfigured: false }), "complete");
});

test("open when complete, open when the settings are unavailable, closed while setting up", () => {
  for (const p of ["/", "/chat", "/admin", "/api/chat/send", "/api/me", "/legal"]) {
    assert.equal(gateAction(p, "complete"), "pass", p);
    assert.equal(gateAction(p, "unknown"), "pass", `${p}: a site that cannot read its config must not show "being set up"`);
  }
  assert.equal(gateAction("/", "setting-up"), "redirect");
  assert.equal(gateAction("/chat", "setting-up"), "redirect");
  assert.equal(gateAction("/admin/site", "setting-up"), "redirect");
  assert.equal(gateAction("/api/chat/send", "setting-up"), "unavailable");
  assert.equal(gateAction("/api", "setting-up"), "unavailable");
});

test("what stays reachable while setting up: setup, sign-in, Matrix discovery, the health check", () => {
  for (const p of ["/setup", "/setup/x", "/api/setup/status", "/api/setup/admin", "/api/auth/mas-initiate", "/api/auth/mas-callback",
    "/api/auth/session", "/auth/signin", "/auth/federated-complete", "/.well-known/matrix/client", "/robots.txt", "/_next/data/x"]) {
    assert.equal(setupPathOpen(p), true, p);
    assert.equal(gateAction(p, "setting-up"), "pass", p);
  }
  // Look-alikes do not slip through.
  for (const p of ["/setupx", "/api/setupx", "/api/authx", "/authority", "/api/admin/instance"]) assert.equal(setupPathOpen(p), false, p);
});

test("proxy.ts asks the gate on every path and keeps Auth.js on the signed-in areas", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../proxy.ts"), "utf8");
  assert.match(src, /if \(!setupPathOpen\(path\)\) \{\n {4}const action = gateAction\(path, await gateState\(\)\);/);
  assert.match(src, /if \(AUTH_AREAS\.test\(path\)\) return \(await authed\(req, ev\)\) \?\? NextResponse\.next\(\);/);
  assert.match(src, /const AUTH_AREAS = \/\^\\\/\(account\|mod\|admin\)\(\\\/\|\$\)\/;/);
  // The state comes from this server's own status route, and a failure to ask is "unknown" (open).
  assert.match(src, /\/api\/setup\/status`/);
  // Next's proxy refuses a relative Location (found on the lab box: "Invalid URL, input: '/setup'").
  assert.match(src, /to\.pathname = "\/setup";[\s\S]{0,80}NextResponse\.redirect\(to, 307\)/);
  assert.doesNotMatch(src, /Location: "\/setup"/);
  assert.match(src, /\} catch \{\n {4}return "unknown";\n {2}\}/);
  // Anchor on the END of the file: the matcher is last — every path but a file, plus image files
  // for the points icon's cache line alone (that branch returns before the gate).
  assert.match(src, /matcher: \[\n {4}"\/\(\(\?!_next\/static\|_next\/image\|\.\*\\\\\.\[A-Za-z0-9\]\+\$\)\.\*\)",\n {4}"[^"\n]+",\n {2}\],\n\};\n$/);
  assert.match(src, /if \(IMAGE_FILE\.test\(path\)\) \{[\s\S]{0,200}return res;\n {2}\}\n {2}return withHeader\(await route\(req, ev, path\)/, "an image file never reaches the gate or Auth.js");
});
