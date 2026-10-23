// The platform ids found from a channel name: a saved channel (or app key) finds its id again, a
// changed channel REPLACES the old id instead of reporting a mismatch, and each failure says what
// to do. No network: the provider check and fetch are passed in.
// Run: node --test app/lib/derivedIds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DERIVED_IDS, idsFoundFrom, findDerivedId } from "./derivedIds.ts";
import { runProviderCheck } from "./instanceSchema.generated.mjs";
import { stripComments } from "./testSource.ts";

const settings = (o: Record<string, string>) => (k: string) => o[k] ?? "";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("which ids a saved key finds again: the channel and the app keys, nothing else", () => {
  assert.deepEqual(idsFoundFrom("platform.twitch.channel"), ["platform.twitch.broadcasterId"]);
  assert.deepEqual(idsFoundFrom("twitch.clientSecret"), ["platform.twitch.broadcasterId"]);
  assert.deepEqual(idsFoundFrom("kick.clientId"), ["platform.kick.userId"]);
  assert.deepEqual(idsFoundFrom("platform.streamplace.channel"), ["platform.streamplace.did"]);
  assert.deepEqual(idsFoundFrom("site.name"), []);
  assert.equal(Object.keys(DERIVED_IDS).length, 3);
});

test("Twitch: a changed channel finds the NEW id through the real provider check, even with an old id saved", async () => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes("oauth2/token")) return json({ access_token: "tok" });
    if (String(url).includes("oauth2/validate")) return json({});
    return json({ data: [{ id: "4242" }] });
  }) as typeof fetch;
  const get = settings({ "platform.twitch.channel": "Casey", "twitch.clientId": "a".repeat(30), "twitch.clientSecret": "b".repeat(30), "platform.twitch.broadcasterId": "1111" });
  const r = await findDerivedId("platform.twitch.broadcasterId", get, runProviderCheck as never, fetchImpl);
  assert.deepEqual(r, { ok: true, id: "4242" }, "the saved 1111 is not a mismatch: the channel is the truth");
  assert.ok(asked.some((u) => u.includes("login=casey")), "asked for the channel in lower case");
});

test("Kick without app keys: says the id is found once they are set; no channel: says to set it", async () => {
  const fetchImpl = (async () => { throw new Error("no network in this test"); }) as typeof fetch;
  assert.deepEqual(await findDerivedId("platform.kick.userId", settings({ "platform.kick.slug": "casey" }), runProviderCheck as never, fetchImpl),
    { ok: false, why: "it is found once the app keys are set" });
  assert.deepEqual(await findDerivedId("platform.kick.userId", settings({}), runProviderCheck as never, fetchImpl), { ok: false, why: "set the channel first" });
});

test("Streamplace: a handle resolves to its DID; a refused handle and a bad answer say so", async () => {
  const did = `did:plc:${"a".repeat(24)}`;
  let url = "";
  const ok = (async (u: string) => { url = String(u); return json({ did }); }) as typeof fetch;
  assert.deepEqual(await findDerivedId("platform.streamplace.did", settings({ "platform.streamplace.channel": "@Casey.site.test" }), runProviderCheck as never, ok), { ok: true, id: did });
  assert.match(url, /resolveHandle\?handle=casey\.site\.test$/);
  const refused = (async () => json({ error: "InvalidRequest" }, 400)) as typeof fetch;
  assert.deepEqual(await findDerivedId("platform.streamplace.did", settings({ "platform.streamplace.channel": "nobody.test" }), runProviderCheck as never, refused), { ok: false, why: "no account by that handle" });
  const odd = (async () => json({ did: "not-a-did" })) as typeof fetch;
  assert.equal((await findDerivedId("platform.streamplace.did", settings({ "platform.streamplace.channel": "x.test" }), runProviderCheck as never, odd)).ok, false);
});

test("the save route and the setup pages find the id after a save; the find route is admin-only and same-origin", () => {
  const web = join(import.meta.dirname, "..", "..");
  const put = stripComments(readFileSync(join(web, "app/api/admin/instance/[key]/route.ts"), "utf8"));
  assert.match(put, /const found = await refindDerivedIds\(name, admin\);/);
  const find = stripComments(readFileSync(join(web, "app/api/admin/instance/[key]/find/route.ts"), "utf8"));
  assert.match(find, /const admin = await requireAdminMutation\(req\);\s*if \(admin instanceof Response\) return admin;/);
  const setup = stripComments(readFileSync(join(web, "app/lib/setup/setupServer.ts"), "utf8"));
  assert.match(setup, /await refindDerivedIds\(Object\.keys\(values\), by\)/);
});
