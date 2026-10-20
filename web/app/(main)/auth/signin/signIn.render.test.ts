// The sign-in page follows the install's settings: the "another server" box only when federated
// sign-in is on (and in allowlist mode it says only some servers may), and the line about new
// accounts says what the homeserver's sign-up actually is.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test "app/(main)/auth/signin/signIn.render.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../../lib/testTsx.ts";
import { signupState, signupLine, federatedLine } from "./signInOptions.ts";
import { stripComments } from "../../../lib/testSource.ts";
const { default: SignInForm } = await import("./SignInForm.tsx");

const html = (federated: "off" | "on" | "allowlist", signup: "open" | "closed" | "unknown") =>
  renderToStaticMarkup(createElement(SignInForm, { options: { federated, signup } }));

test("federated sign-in off (the default): no box, no divider, no Matrix id field", () => {
  const out = html("off", "open");
  assert.doesNotMatch(out, /another server/);
  assert.doesNotMatch(out, /@you:matrix\.org/);
  assert.doesNotMatch(out, /data-federated/);
  assert.match(out, />Sign in</, "the site's own sign-in stays");
});

test("on: the box is offered; allowlist: it says only some servers may use it", () => {
  const on = html("on", "open");
  assert.match(on, /or use a Matrix account from another server/);
  assert.match(on, /data-federated="on"/);
  assert.doesNotMatch(on, /Only accounts on the servers this site allows/);
  const allow = html("allowlist", "open");
  assert.match(allow, /data-federated="allowlist"/);
  assert.match(allow, /Only accounts on the servers this site allows can sign in this way\./);
});

test("the new-account line follows the sign-up state", () => {
  assert.match(html("off", "open"), /data-signup-line="open"[^>]*>New here\? Signing in creates your free [^<]* account\.</);
  assert.match(html("off", "closed"), /New accounts are not open on [^<]* right now — existing accounts can sign in\./);
  assert.doesNotMatch(html("off", "closed"), /creates your free/);
  assert.match(html("off", "unknown"), /if [^<]* is taking new accounts, the sign-in page lets you make one\./i);
});

test("sign-up state: the bundle's rule (closed until setup is done, unset = closed); elsewhere not known", () => {
  assert.equal(signupState({ bundle: true, registration: "open", setupDone: true }), "open");
  assert.equal(signupState({ bundle: true, registration: null, setupDone: true }), "closed", "unset = closed");
  assert.equal(signupState({ bundle: true, registration: "open", setupDone: false }), "closed", "always closed while setup runs");
  assert.equal(signupState({ bundle: false, registration: "open", setupDone: true }), "unknown", "a homeserver run elsewhere keeps its own setting");
  assert.equal(federatedLine("off"), null);
  assert.equal(signupLine("open", "Site").includes("Site"), true);
});

test("the page reads the settings per request and passes them in", () => {
  const page = stripComments(readFileSync(join(import.meta.dirname, "page.tsx"), "utf8"));
  assert.match(page, /export const dynamic = "force-dynamic";/);
  assert.match(page, /federated: federatedSignInMode\(\),/);
  assert.match(page, /registration: instanceString\("matrix\.registration"\),/);
  assert.match(page, /bundle: hostRequestsAvailable\(\),/);
  assert.match(page, /<SignInForm options=\{\{[\s\S]*\}\} \/>\s*\);\s*\}\s*$/, "read to its end");
});
