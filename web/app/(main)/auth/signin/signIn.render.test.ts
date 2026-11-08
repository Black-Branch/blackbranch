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

// ── A sign-in the callback refused comes back as ?error=<code>; the page says why ─────────────────
// The two codes both callbacks send when a NEW account is refused (lib/lockdown.ts) concern the
// site's own sign-in, so they show under the main button whatever the federated setting is.
const { dom, React, act } = await import("../../../lib/testDom.ts");
const { createRoot } = await import("react-dom/client");
// next/link's prefetch observer reaches for `self` (a browser global jsdom does not install).
(globalThis as unknown as { self: unknown }).self ??= globalThis;

async function mountAt(search: string, federated: "off" | "on" = "off") {
  dom.reconfigure({ url: `https://example.org/auth/signin${search}` });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(SignInForm, { options: { federated, signup: "open" } })); });
  await act(async () => { await Promise.resolve(); });
  const red = () => [...container.querySelectorAll("p.text-red-400")].map((p) => p.textContent);
  return { container, root, red };
}

test("?error=signups_disabled / unavailable → the sentence, under the main button, federated off or on", async () => {
  for (const federated of ["off", "on"] as const) {
    const paused = await mountAt("?error=signups_disabled", federated);
    assert.deepEqual(paused.red(), ["New accounts are paused on this site right now."]);
    const main = [...paused.container.querySelectorAll("button")].find((b) => b.textContent === "Sign in")!.parentElement!;
    assert.equal(main.querySelector("p.text-red-400")?.textContent, "New accounts are paused on this site right now.",
      `under the main button (federated ${federated})`);
    await act(async () => paused.root.unmount());
    const down = await mountAt("?error=unavailable", federated);
    assert.deepEqual(down.red(), ["Sign-in is unavailable right now — try again in a few minutes."]);
    await act(async () => down.root.unmount());
  }
  const plain = await mountAt("");
  assert.deepEqual(plain.red(), [], "no ?error: nothing said");
  await act(async () => plain.root.unmount());
});

test("restart: a fresh load of the same refused URL says it again; a load without ?error says nothing", async () => {
  const first = await mountAt("?error=signups_disabled");
  await act(async () => first.root.unmount());
  const again = await mountAt("?error=signups_disabled");
  assert.deepEqual(again.red(), ["New accounts are paused on this site right now."]);
  await act(async () => again.root.unmount());
  const clean = await mountAt("");
  assert.deepEqual(clean.red(), []);
  await act(async () => clean.root.unmount());
});

test("retry: pressing Sign in again clears the old sentence; a failed retry shows only its own line", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 503 }))) as typeof fetch;
  try {
    const m = await mountAt("?error=signups_disabled");
    assert.deepEqual(m.red(), ["New accounts are paused on this site right now."], "the refusal is said first");
    const button = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Sign in");
    assert.ok(button, "the main Sign in button");
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const said = m.red();
    assert.equal(said.length, 1, `one line, not two: ${JSON.stringify(said)}`);
    assert.doesNotMatch(said[0] ?? "", /New accounts are paused/);
    await act(async () => m.root.unmount());
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the refusal codes are the ones lib/lockdown.ts sends", () => {
  const form = stripComments(readFileSync(join(import.meta.dirname, "SignInForm.tsx"), "utf8"));
  assert.match(form, /import type \{ SignupDecision \} from "@\/app\/lib\/lockdown";/);
  assert.match(form, /Record<Extract<SignupDecision, \{ allowed: false \}>\["reason"\], string>/);
  assert.match(form, /\n\}\s*$/, "read to its end");
});
