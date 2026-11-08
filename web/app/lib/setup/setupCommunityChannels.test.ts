// Setup's Community step lists the default channels as editable names (spec 2026-10-23 §4.6, plan
// Task 1.11): general, announcements, forum, off-topic. #general and #forum are made by the step's
// bootstrap; the rest is stored as community.setupChannels BEFORE the bootstrap is asked for, and
// the reconciler's first import of the community's home turns it into rows (adoptServer.ts) — a
// channel row needs its home's row, which does not exist until that import.
// Run: env -u DATABASE_URL node --test app/lib/setup/setupCommunityChannels.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCommunityStep } from "./setupValidate.ts";
import { DEFAULT_SETUP_CHANNELS, encodeSetupChannels, stepChannelsFrom, setupChannelsNeedWrite } from "../community/setupChannels.ts";
import { stripComments } from "../testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const server = stripComments(readFileSync(join(here, "setupServer.ts"), "utf8"));
const wizard = readFileSync(join(here, "../../features/setup/SetupWizard.tsx"), "utf8");
function body(sig: string): string {
  const start = server.indexOf(sig);
  assert.ok(start >= 0, `${sig} not found`);
  return server.slice(start, server.indexOf("\n}\n", start));
}

test("stores the default list: a page that sends none stores announcements and off-topic (general and forum come with the community)", () => {
  const v = validateCommunityStep({ federation: false, registration: "open" });
  assert.ok(v.ok);
  assert.deepEqual(v.channels, DEFAULT_SETUP_CHANNELS);
  assert.deepEqual(encodeSetupChannels(v.channels), ["announcement:announcements", "text:off-topic"]);
  // An edited list is checked, and its error is the step's.
  const edited = validateCommunityStep({ federation: false, registration: "open", channels: [{ kind: "text", name: "#clips" }] });
  assert.ok(edited.ok); assert.deepEqual(edited.channels, [{ kind: "text", name: "clips" }]);
  const none = validateCommunityStep({ federation: false, registration: "open", channels: [] });
  assert.ok(none.ok); assert.deepEqual(none.channels, [], "the two made with the community are enough");
  const bad = validateCommunityStep({ federation: false, registration: "open", channels: [{ kind: "text", name: "general" }] });
  assert.equal(bad.ok, false); assert.match((bad as { error: string }).error, /#general is made with the community/);
});

test("the server stores the list before it asks the host for the community, and only when it changed", () => {
  const sc = body("export async function startCommunity(");
  const store = sc.indexOf('await writeSetting("community.setupChannels", stored)');
  const ask = sc.indexOf('await requestHost("matrix-bootstrap")');
  assert.ok(store > 0 && ask > 0 && store < ask, "stored, then the host is asked");
  // Written when it was never stored (an empty list too — "none" is an answer) or when it changed.
  assert.match(sc, /const stored = encodeSetupChannels\(v\.channels\);\n\s+if \(setupChannelsNeedWrite\(instanceResolve\("community\.setupChannels"\), stored\)\) await writeSetting\("community\.setupChannels", stored\);/);
  // The step's page tells "never stored" (the defaults) from "stored empty" (none).
  const data = body("async function stepData(");
  assert.match(data, /channels: stepChannelsFrom\(instanceResolve\("community\.setupChannels"\), !!instanceString\("matrix\.rooms\.hub"\)\)/);
});

test("restart: a cleared list stays cleared on reload; never stored shows the defaults until the community is made", () => {
  const def = { value: [], source: "default" as const };
  assert.deepEqual(stepChannelsFrom(def, false), DEFAULT_SETUP_CHANNELS);
  assert.deepEqual(stepChannelsFrom(def, true), [], "made before the list existed: nothing waits");
  assert.deepEqual(stepChannelsFrom({ value: [], source: "database" }, false), [], "cleared stays cleared");
  assert.deepEqual(stepChannelsFrom({ value: ["text:clips"], source: "database" }, true), [{ kind: "text", name: "clips" }]);
  // retry: the same answer sent again is not written again; a first empty answer is.
  assert.equal(setupChannelsNeedWrite(def, []), true);
  assert.equal(setupChannelsNeedWrite({ value: [], source: "database" }, []), false);
  assert.equal(setupChannelsNeedWrite({ value: ["text:a"], source: "database" }, ["text:b"]), true);
});

test("the page lists #general and #forum as made now and the rest as editable names, and sends them", () => {
  assert.match(wizard, /call\("\/api\/setup\/community", \{ federation, registration, channels \}\)/);
  assert.match(wizard, /STARTING_CHANNELS\.map\(\(c\) =>/);
  assert.match(wizard, /aria-label=\{`Channel \$\{i \+ 1\} name`\}/);
  assert.match(wizard, /Add a channel/);
  // Plain words: no Matrix terms on the step.
  const step = wizard.slice(wizard.indexOf("function Community("), wizard.indexOf("type HostAnswer"));
  assert.ok(step.length > 500, "vacuity: the step was found");
  assert.doesNotMatch(step.replace(/matrix-bootstrap|matrix bootstrap/g, ""), /power level|join rule|state event|reconciler|appservice/i);
});

test("END anchor: setupServer.ts and SetupWizard.tsx were read to their last lines", () => {
  assert.match(server, /export async function finishStatus\(req: Request\): Promise<Out> \{[\s\S]*\n\}\n$/);
  assert.match(wizard, /return <Shell siteName=\{siteName\}><NotYou adminExists=\{view\.phase === "signin" && view\.adminExists\} \/><\/Shell>;\n\}\n$/);
});
