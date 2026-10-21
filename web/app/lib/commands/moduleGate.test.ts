// A command for a part this install does not run is neither offered (picker, /help) nor
// run (refused in words). The `module` field names that part; siteFeatures.ts answers for it.
//
// Run: node --test app/lib/commands/moduleGate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../testTsx.ts";
import type { CommandNode } from "./spec.ts";
import { MODULES } from "../instanceSchema.generated.mjs";

const { COMMANDS, leaves } = await import("./spec.ts");
const { parseCommandLine, suggestFor, helpText } = await import("./parse.ts");
const { createCommandRunner } = await import("./run.ts");
const { setSiteFeatures, featureOn } = await import("../siteFeatures.ts");

const ttsOff = (id: string) => id !== "tts";
const allOn = () => true;
const VIEWER = { isMod: false, isAdmin: false, dests: ["youtube", "twitch"], isSupporter: true };

const offered = (typed: string, features: (id: string) => boolean) =>
  suggestFor(parseCommandLine(typed), { ...VIEWER, features }).map((s) => s.value);

test("the picker: /tts is not offered while the voice is off, and is with it on", () => {
  assert.ok(!offered("/t", ttsOff).includes("/tts"));
  assert.ok(offered("/t", ttsOff).includes("/twitch"), "vacuity: the other /t… commands are still offered");
  assert.ok(offered("/t", allOn).includes("/tts"));
});

test("/help leaves out a switched-off part's commands", () => {
  assert.doesNotMatch(helpText("", { ...VIEWER, features: ttsOff }), /^\/tts /m);
  assert.match(helpText("", { ...VIEWER, features: allOn }), /^\/tts /m);
});

test("the runner refuses a switched-off part's command in words, and runs it once the part is on (restart)", async () => {
  const { runCommand } = createCommandRunner({ setSendError: () => {}, showNotice: () => {} });
  const off = await runCommand("/tts hello there", { ...VIEWER, features: ttsOff });
  assert.deepEqual(off, { kind: "rejected", message: "/tts isn't available on this site." });
  const aliasOff = await runCommand("/speak hello there", { ...VIEWER, features: ttsOff });
  assert.equal(aliasOff.kind, "rejected", "the alias is refused too");
  const on = await runCommand("/tts hello there", { ...VIEWER, features: allOn });
  assert.equal(on.kind, "send");
});

test("YouTube's send command follows the YouTube module", async () => {
  assert.ok(!offered("/y", (id) => id !== "youtube").includes("/youtube"));
  const { runCommand } = createCommandRunner({ setSendError: () => {}, showNotice: () => {} });
  assert.equal((await runCommand("/y hi", { ...VIEWER, features: (id) => id !== "youtube" })).kind, "rejected");
});

test("every `module` names a real module or a fact feature — a typo would hide a command forever", () => {
  const known = new Set([...MODULES.map((m) => m.id), "tts", "subscriptions", "purchasable"]);
  const tagged: string[] = [];
  const walk = (nodes: CommandNode[]) => { for (const n of nodes) { if (n.module) { tagged.push(n.name); assert.ok(known.has(n.module), `${n.name}: unknown module ${n.module}`); } if (n.sub) walk(n.sub); } };
  walk(COMMANDS);
  assert.ok(tagged.length >= 2, "vacuity: tagged commands exist");
});

test("the always-mounted parts carry no module: timer, bar, emotes, link gate (their stream-api routes are core)", () => {
  for (const name of ["timer", "bar", "emotes", "linkgate", "blacklist", "whitelist"]) {
    const root = COMMANDS.find((c) => c.name === name);
    assert.ok(root, `${name} exists`);
    assert.equal(root!.module, undefined, `${name} is core`);
    for (const { node } of leaves([root!])) assert.equal(node.module, undefined, `${name} ${node.name} is core`);
  }
  // The snapshot that says so: only radio and obs own stream-api routes as modules.
  const snap = JSON.parse(readFileSync(new URL("../../../../stream-api/route-surface.snapshot.json", import.meta.url), "utf8")) as { modules: Record<string, string[]> };
  const moduleRoutes = Object.values(snap.modules).flat().join("\n");
  assert.doesNotMatch(moduleRoutes, /\/timer\/|\/support-bar\/|\/emotes|link/);
});

test("siteFeatures: nothing install-specific is on before the page says; then exactly what it said", () => {
  assert.equal(featureOn(undefined), true, "a command with no module is always available");
  assert.equal(featureOn("tts"), false, "before the page says: off");
  setSiteFeatures({ off: ["radio"], purchasable: false, subscriptions: true, tts: true });
  assert.equal(featureOn("tts"), true);
  assert.equal(featureOn("subscriptions"), true);
  assert.equal(featureOn("purchasable"), false);
  assert.equal(featureOn("radio"), false);
  assert.equal(featureOn("youtube"), true);
});

test("wiring: ChatInput hands the picker and runner the install's features; the + menu gates Read aloud and the redaction row", () => {
  const input = readFileSync(new URL("../../features/chat/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(input, /features: featureOn/);
  const tools = readFileSync(new URL("../../components/ComposerToolsPopover.tsx", import.meta.url), "utf8");
  assert.match(tools, /\{\(featureOn\("tts"\) \|\| spendMode === "tts"\) && <button/);
  assert.match(tools, /\{\(canEncrypt === true \|\| encryptArmed \|\| featureOn\("subscriptions"\)\) && <button/);
  const send = readFileSync(new URL("../useSendChatMessage.ts", import.meta.url), "utf8");
  assert.doesNotMatch(send, /social credit/, "W21: the score's name is the install's (scoreName), never 'social credit'");
  assert.match(send, /\$\{scoreName\(\)\} of at least \$\{REDACT_MIN_CREDIT\}/);
  // Vacuity anchor at the END of the file: the scan read the whole popover.
  assert.match(tools.trimEnd(), /\}$/);
});
