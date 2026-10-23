// What the setup pages add on top of the setup lists: every key it names is a settings key, every
// step it helps exists, and each value's format check takes the real shape and refuses the
// wrong pastes people make.
// Run: node --test app/lib/setup/setupExtras.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_KEYS, MODULES, SETUP_CORE } from "../instanceSchema.generated.mjs";
import { STEP_HELP, WIZARD_STEPS, WIZARD_LISTS, FIELD_FORMATS, ADMIN_ONLY_SETUP, formatProblem } from "./setupExtras.ts";

const keys = new Set((INSTANCE_KEYS as { key: string }[]).map((k) => k.key));
type Step = { id: string; fields: string[] };
const lists = new Map<string, Step[]>([
  ...(MODULES as { id: string; setup?: Step[] }[]).filter((m) => m.setup).map((m) => [`module:${m.id}`, m.setup!] as [string, Step[]]),
  ...(SETUP_CORE as { id: string; steps: Step[] }[]).map((c) => [`core:${c.id}`, c.steps] as [string, Step[]]),
  ...WIZARD_LISTS.filter((w) => w.own).map((w) => [`core:${w.id}`, w.own!] as [string, Step[]]),
]);

test("every key the setup pages add or check is a settings key, and never an install-tier one", () => {
  const named = [
    ...Object.keys(FIELD_FORMATS),
    ...Object.values(WIZARD_STEPS).flatMap((x) => x.flatMap((s) => s.step.fields)),
    ...WIZARD_LISTS.flatMap((w) => (w.own ?? []).flatMap((s) => s.fields)),
  ];
  assert.ok(named.length >= 28, `vacuity: only ${named.length} keys named`);
  for (const k of named) {
    assert.ok(keys.has(k), `${k} is not a settings key`);
    assert.notEqual((INSTANCE_KEYS as { key: string; tier: string }[]).find((e) => e.key === k)!.tier, "install", `${k} is set in .env, not on a page`);
  }
});

test("every step the help and the added steps name exists in its list", () => {
  for (const ref of Object.keys(STEP_HELP)) {
    const [list, step] = ref.split("/");
    assert.ok(lists.get(list!)?.some((s) => s.id === step), `${ref} names no step`);
  }
  for (const [list, added] of Object.entries(WIZARD_STEPS)) {
    for (const { after } of added) if (after) assert.ok(lists.get(list)?.some((s) => s.id === after), `${list}: no step ${after} to follow`);
  }
  for (const w of WIZARD_LISTS) if (w.source) assert.ok(lists.has(`core:${w.source}`), `${w.id}: no list ${w.source}`);
  for (const id of Object.keys(ADMIN_ONLY_SETUP)) assert.ok(lists.has(`module:${id}`), `${id}: not a module with setup`);
});

test("every field on a setup page has a format check", () => {
  const onPages = [...lists.values()].flat().flatMap((s) => s.fields)
    .concat(Object.values(WIZARD_STEPS).flatMap((x) => x.flatMap((s) => s.step.fields)));
  const free = new Set(["paypal.env", "timer.pauseScene", "tts.enabled", "obs.password", "obs.soundSource", "obs.botScene", "obs.botSource"]);
  for (const k of onPages) if (!free.has(k)) assert.ok(FIELD_FORMATS[k], `${k}: no format check`);
});

test("the format checks take the real shapes", () => {
  for (const [key, value] of [
    ["stripe.secretKey", "rk_live_FAKEKEY1"], ["stripe.secretKey", "sk_test_FAKEKEY1"],
    ["stripe.publishableKey", "pk_test_FAKEKEY1"], ["stripe.webhookSecret", "whsec_FAKEFAKE1"],
    ["stripe.supporterPriceId", "price_1QxYzAbCdEf"], ["paypal.webhookId", "8PT597110X687430LKGECATA"],
    ["twitch.clientId", "fakefakefakefakefake1234"], ["platform.twitch.channel", "casey_streams"],
    ["platform.kick.slug", "casey-streams"], ["platform.youtube.channelId", "UC_x5XG1OV2P6uZZ5FSM9Ttw"],
    ["youtube.apiKey", `AIza${"a".repeat(35)}`], ["platform.streamplace.did", "did:plc:abcdefghijklmnopqrstuvwx"],
    ["platform.streamplace.channel", "casey.bsky.social"], ["kofi.verificationToken", "00000000-0000-4000-8000-000000000000"],
    ["streamlabs.socketToken", "eyJFAKE.eyJFAKE.FAKEFAKE"], ["tts.voiceCasual", "FAKEVOICE000"],
    ["kick.chatroomId", "123456"], ["site.donateUrl", "https://ko-fi.com/casey"],
  ] as const) assert.equal(formatProblem(key, value), null, `${key}: ${value}`);
  assert.equal(formatProblem("stripe.secretKey", "   "), null, "blank = unset, never a format problem");
  assert.equal(formatProblem("not.a.key", "anything"), null);
});

test("the format checks refuse the wrong pastes people make, and say what is expected", () => {
  for (const [key, value, says] of [
    ["stripe.supporterPriceId", "prod_QxYzAbCdEf", /price_/], ["stripe.publishableKey", "rk_live_FAKEKEY1", /pk_/],
    ["stripe.secretKey", "pk_live_FAKEKEY1", /rk_/], ["stripe.webhookSecret", "we_1AbCd", /whsec_/],
    ["platform.twitch.channel", "https://twitch.tv/casey", /name only/], ["platform.youtube.channelId", "@casey", /UC/],
    ["platform.kick.userId", "casey", /digits/], ["site.donateUrl", "http://ko-fi.com/casey", /https/],
    ["site.donateUrl", "ko-fi.com/casey", /https/], ["platform.streamplace.channel", "@casey.bsky.social", /without the @/],
  ] as const) assert.match(formatProblem(key, value) ?? "(accepted)", says, `${key}: ${value}`);
});
