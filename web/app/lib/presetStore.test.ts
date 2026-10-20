// The preset slots' store, shared by the settings menu and the terminal: the
// account's slots with a signed-out fallback to the browser's, the one-time
// import of a browser's slots into an EMPTY account, save, clear, and the
// house looks. fetch is a stub that records what was asked.
//
// Run: node --test app/lib/presetStore.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import { resetStorage } from "./testDom.ts";
const { lsGet, lsGetJSON, lsSetJSON } = await import("./safeLocalStorage.ts");
const { loadPresets, savePreset, clearPreset, loadHouseLooks, slotFiles, presetKey } = await import("./presetStore.ts");

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
/** Answer each URL with a status and body; everything else is a 404. */
function serve(routes: Record<string, { status?: number; body?: unknown }>) {
  calls.length = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(url)}`;
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[key] ?? routes[String(url)] ?? { status: 404, body: { error: "no" } };
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

test("signed in: the account's slots; a browser's slots are imported once, only into an empty account", async () => {
  resetStorage();
  lsSetJSON(presetKey(2), { chatStyle_fontWeight: "600" });
  serve({
    "GET /api/me/presets": { body: { presets: [] } },
    "PUT /api/me/presets": { body: { preset: { slot: 2, name: null, settings: { chatStyle_fontWeight: "600" } } } },
  });
  const a = await loadPresets();
  assert.equal(a.mode, "account");
  assert.deepEqual(a.presets, [{ slot: 2, name: null, settings: { chatStyle_fontWeight: "600" } }]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET /api/me/presets", "PUT /api/me/presets"]);
  assert.deepEqual(calls[1]!.body, { slot: 2, settings: { chatStyle_fontWeight: "600" } });
  assert.equal(lsGet("bb_preset_imported"), "1", "remembered: this browser has offered its slots");
  // Next time: nothing to import (the flag), and a filled account is never imported into.
  serve({ "GET /api/me/presets": { body: { presets: [{ slot: 1, name: "Day", settings: {} }] } } });
  const b = await loadPresets();
  assert.deepEqual(b.presets.map((p) => p.slot), [1]);
  assert.deepEqual(calls.map((c) => c.method), ["GET"], "no PUT");
});

test("signed out (401) or offline: the browser's slots, and which are filled", async () => {
  resetStorage();
  lsSetJSON(presetKey(3), { chatStyle_fontWeight: "700" });
  serve({ "GET /api/me/presets": { status: 401, body: { error: "sign in" } } });
  const r = await loadPresets();
  assert.equal(r.mode, "local");
  assert.deepEqual(r.filled, { 1: false, 2: false, 3: true, 4: false });
  assert.deepEqual(r.presets, [{ slot: 3, name: null, settings: { chatStyle_fontWeight: "700" } }], "a browser slot reads as a nameless preset");
});

test("save and clear go to the account when signed in, to the browser when not; a failed account save throws", async () => {
  resetStorage();
  serve({
    "PUT /api/me/presets": { body: { preset: { slot: 1, name: "Night", settings: { a: "1" } } } },
    "DELETE /api/me/presets?slot=1": { status: 204 },
  });
  const saved = await savePreset("account", 1, { a: "1" }, "Night");
  assert.deepEqual(saved, { slot: 1, name: "Night", settings: { a: "1" } });
  assert.deepEqual(calls[0]!.body, { slot: 1, name: "Night", settings: { a: "1" } });
  await clearPreset("account", 1);
  assert.equal(calls[1]!.method, "DELETE");
  assert.equal(lsGet(presetKey(1)), null, "the browser's copy goes too");

  const local = await savePreset("local", 2, { b: "2" });
  assert.deepEqual(local, { slot: 2, name: null, settings: { b: "2" } });
  assert.deepEqual(lsGetJSON(presetKey(2), null), { b: "2" });
  assert.equal(calls.length, 2, "no request for a browser slot");
  await clearPreset("local", 2);
  assert.equal(lsGet(presetKey(2)), null);

  serve({ "PUT /api/me/presets": { status: 500, body: { error: "db down" } } });
  await assert.rejects(savePreset("account", 1, { a: "1" }), /db down/, "a save that failed says so — never silently");
});

test("house looks by slot; a failed fetch is no house looks", async () => {
  serve({ "GET /api/house-looks": { body: { looks: [{ slot: 2, name: "Dusk", settings: { a: "1" } }] } } });
  assert.deepEqual(await loadHouseLooks(), { 2: { name: "Dusk", settings: { a: "1" } } });
  serve({});
  assert.deepEqual(await loadHouseLooks(), {});
});

test("slotFiles: each slot as the terminal lists it — your own, else the house look, else nothing", () => {
  const files = slotFiles(
    [{ slot: 1, name: "Day", settings: { a: "1" } }],
    { 1: { name: "H1", settings: { h: "1" } }, 2: { name: "Dusk", settings: { h: "2" } } },
  );
  assert.deepEqual(files, [
    { slot: 1, own: true, name: "Day", settings: { a: "1" }, houseBehind: true },
    { slot: 2, own: false, name: "Dusk", settings: { h: "2" }, houseBehind: true },
  ]);
});
