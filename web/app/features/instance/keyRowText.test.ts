// Run: node --test app/features/instance/keyRowText.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitHint, pendingRestarts, desiredSwitch, currentValue, currentList, listAdd, listRemove, draftOf, hostApplyState,
} from "./keyRowText.ts";
import { INSTANCE_KEYS } from "../../lib/instanceSchema.generated.mjs";
import { isHostRendered } from "../../lib/hostRequests.ts";

test("the hint is the first sentence; the rest goes behind Details", () => {
  assert.deepEqual(splitHint("What a viewer reads as the name of this site. Page titles, the sign-in page."),
    { hint: "What a viewer reads as the name of this site.", rest: "Page titles, the sign-in page." });
});

test("one sentence: all hint, no rest", () => {
  assert.deepEqual(splitHint("The bot's Matrix account."), { hint: "The bot's Matrix account.", rest: "" });
});

test("abbreviations and decimals do not cut the hint short", () => {
  assert.equal(splitHint("Wait e.g. a minute or 1.5 s before retrying. Then stop.").hint, "Wait e.g. a minute or 1.5 s before retrying.");
});

test("an empty description is an empty hint", () => {
  assert.deepEqual(splitHint(undefined), { hint: "", rest: "" });
});

const sw = (key: string, label: string, web: boolean | undefined, api: boolean, known = true) => ({
  key, label, kind: "bool", tier: "instance", reload: "restart",
  packages: [...(web === undefined ? [] : [{ package: "web", known: true, display: web }]), { package: "stream-api", known, display: api }],
});

test("pending restart: a service still on the old value of a switch is listed with the switch", () => {
  assert.deepEqual(pendingRestarts([sw("modules.radio", "Radio", false, true), sw("modules.obs", "OBS", true, true), sw("modules.lights", "Lights", true, false)]),
    [{ service: "stream-api", labels: ["Radio", "Lights"] }]);
});

test("pending restart: nothing when every service agrees, a service not reporting, or a key read live", () => {
  assert.deepEqual(pendingRestarts([sw("modules.radio", "Radio", true, true), sw("modules.obs", "OBS", false, true, false), { ...sw("site.x", "X", true, false), reload: "live" }]), []);
});

test("pending restart: a switch only the chat service reads compares with the SAVED value, not its own report", () => {
  assert.deepEqual(pendingRestarts([sw("modules.meter", "Meter", undefined, true)]), [], "nothing saved, nothing pending");
  assert.deepEqual(pendingRestarts([{ ...sw("modules.obs", "OBS", undefined, false), stored: { display: true } }]),
    [{ service: "stream-api", labels: ["OBS"] }], "saved on, still running off");
});

test("pending restart: any restart setting, not only a switch — a channel, a credential (by its …abcd)", () => {
  const channel = {
    key: "platform.twitch.channel", label: "Twitch channel", kind: "string", tier: "instance", reload: "restart",
    stored: { display: "newchan" },
    packages: [{ package: "web", known: true, display: "newchan" }, { package: "stream-ingest", known: true, display: "oldchan" }],
  };
  const token = {
    key: "obs.password", label: "OBS password", kind: "secret", tier: "secret", reload: "restart", secret: true,
    stored: { display: "…wxyz" }, packages: [{ package: "stream-api", known: true, display: "…abcd" }],
  };
  assert.deepEqual(pendingRestarts([channel, token]), [
    { service: "stream-ingest", labels: ["Twitch channel"] }, { service: "stream-api", labels: ["OBS password"] },
  ]);
  // A service whose own environment sets the value would not change on a restart.
  assert.deepEqual(pendingRestarts([{ ...token, packages: [{ ...token.packages[0]!, source: "env" }] }]), []);
  // A host-applied setting waits for the host's render, never for a restart.
  assert.deepEqual(pendingRestarts([{ ...channel, key: "matrix.federation", hostApplied: true }]), []);
});

test("the restart set is the SCHEMA's: every reload:'restart' setting a service reads goes pending when it runs an old value", () => {
  // Derived, never a hand list: a new restart setting is covered the day it is declared.
  const restartKeys = INSTANCE_KEYS.filter((e) => e.reload === "restart" && e.tier !== "install" && !isHostRendered(e.key) && e.packages.some((p) => p !== "web"));
  assert.ok(restartKeys.length >= 8, `vacuity: ${restartKeys.length} restart settings`);
  const ids = restartKeys.map((e) => e.key);
  for (const sample of ["platform.twitch.channel", "platform.kick.slug", "platform.youtube.channelId", "streamlabs.socketToken", "obs.password", "modules.obs"]) {
    assert.ok(ids.includes(sample), `${sample} is a restart setting a service reads`);
  }
  for (const e of restartKeys) {
    const row = {
      key: e.key, label: e.label, kind: e.kind, tier: e.tier, reload: e.reload, secret: e.secret, hostApplied: false,
      stored: { display: e.kind === "bool" ? true : e.secret ? "…new1" : "new" },
      packages: e.packages.filter((p) => p !== "web").map((p) => ({ package: p, known: true, display: e.kind === "bool" ? false : e.secret ? "…old1" : "old", source: "database" })),
    };
    const pend = pendingRestarts([row]);
    assert.ok(pend.length > 0 && pend.every((x) => x.labels.includes(e.label)), `${e.key} is not shown as waiting for a restart`);
  }
  // The host-applied two are not in it: they wait for a render.
  assert.ok(INSTANCE_KEYS.filter((e) => isHostRendered(e.key)).every((e) => e.reload === "restart"));
});

test("a switch's wanted state: saved, else the website's, else the default", () => {
  assert.equal(desiredSwitch({ ...sw("modules.obs", "OBS", undefined, false), stored: { display: true } }), true);
  assert.equal(desiredSwitch(sw("modules.radio", "Radio", true, false)), true);
  assert.equal(desiredSwitch({ ...sw("modules.obs", "OBS", undefined, true), defaultValue: false }), false);
});

const row = (over: Record<string, unknown>) => ({
  key: "k", label: "K", kind: "string", tier: "instance", reload: "live",
  packages: [{ package: "web", known: true, display: null as unknown }], ...over,
});

test("a row's current value: saved, else what the website reads, else the default — never a credential's", () => {
  assert.equal(currentValue(row({ stored: { display: "closed" }, packages: [{ package: "web", known: true, display: "open" }] })), "closed");
  assert.equal(currentValue(row({ packages: [{ package: "web", known: true, display: "allowlist" }] })), "allowlist");
  assert.equal(currentValue(row({ defaultValue: "off" })), "off");
  assert.equal(currentValue(row({ secret: true, stored: { display: "…abcd" } })), null);
  assert.equal(draftOf(row({ kind: "number", packages: [{ package: "web", known: true, display: 4 }] })), "4");
  assert.equal(draftOf(row({ kind: "enum" })), "", "nothing set and no default: the choice starts empty");
});

test("a list is edited by adding to and removing from what is there — a save never drops the others", () => {
  const deny = row({ kind: "list", stored: { display: ["one.test", "two.test"] } });
  assert.deepEqual(currentList(deny), ["one.test", "two.test"]);
  assert.deepEqual(listAdd(currentList(deny), "three.test"), ["one.test", "two.test", "three.test"], "typing one server keeps the others");
  assert.deepEqual(listAdd(currentList(deny), " four.test, two.test  five.test"), ["one.test", "two.test", "four.test", "five.test"]);
  assert.deepEqual(listRemove(currentList(deny), "one.test"), ["two.test"]);
  assert.deepEqual(currentList(row({ kind: "list" })), []);
});

test("a host-applied setting: applying until the host's render answers the save, then its result", () => {
  const saved = row({ key: "matrix.federation", hostApplied: true, stored: { display: true, updatedAt: "2026-10-18T10:00:00.400Z" } });
  assert.deepEqual(hostApplyState(saved, null), { state: "applying" });
  assert.deepEqual(hostApplyState(saved, { ok: true, at: "2026-10-18T09:50:00Z", message: "" }), { state: "applying" }, "an older render");
  assert.deepEqual(hostApplyState(saved, { ok: true, at: "2026-10-18T10:00:30Z", message: "" }), { state: "applied", at: "2026-10-18T10:00:30Z" });
  assert.deepEqual(hostApplyState(saved, { ok: false, at: "2026-10-18T10:00:30Z", message: "synapse did not start" }), { state: "failed", message: "synapse did not start" });
  assert.deepEqual(hostApplyState(row({ hostApplied: true }), null), { state: "none" }, "nothing saved here");
});
