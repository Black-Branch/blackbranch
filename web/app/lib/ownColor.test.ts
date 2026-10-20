// Your name colour from anywhere: on the page at once, saved coalesced — a
// script that sets a colour on every message costs at most one save every five
// seconds, the newest colour wins — and the terminal's profile file and the
// picker go through the same function.
//
// Run: node --test app/lib/ownColor.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import { dom } from "./testDom.ts";

const { colorSaver, setOwnColor } = await import("./ownColor.ts");

/** A fake clock: timers fire only when time is moved. */
function clock() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const i = ++id; timers.set(i, { at: t + ms, fn }); return i as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (i: ReturnType<typeof setTimeout>) => { timers.delete(i as unknown as number); },
    async tick(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        t = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}
function rig() {
  const c = clock();
  const shown: (string | null)[] = [];
  const saved: { hex: string | null; at: number; keepalive: boolean }[] = [];
  const s = colorSaver({ local: (h) => shown.push(h), save: async (hex, keepalive) => { saved.push({ hex, at: c.now(), keepalive }); return true; }, ...c });
  return { c, s, shown, saved };
}

test("shown at once; saved once, half a second after the last change, the newest colour", async () => {
  const { c, s, shown, saved } = rig();
  void s.set("#111111");
  await c.tick(200);
  void s.set("#222222");
  assert.deepEqual(shown, ["#111111", "#222222"], "the page shows each one immediately");
  assert.equal(saved.length, 0);
  await c.tick(499);
  assert.equal(saved.length, 0);
  await c.tick(1);
  assert.deepEqual(saved.map((x) => [x.hex, x.at]), [["#222222", 700]]);
});

test("a hook setting a colour on every message: at most one save every 5 s, whatever the loop does", async () => {
  const { c, s, saved } = rig();
  for (let i = 0; i < 100; i++) { void s.set(`#${String(i).padStart(6, "0")}`); await c.tick(600); }
  assert.ok(saved.length <= 13, `${saved.length} saves in a minute`);
  for (let i = 1; i < saved.length; i++) assert.ok(saved[i]!.at - saved[i - 1]!.at >= 5000, "five seconds apart");
  await c.tick(10_000);
  assert.equal(saved.at(-1)?.hex, "#000099", "the newest one always lands");
});

test("the way out: what waits is sent now, with keepalive; a set's promise resolves once its save landed", async () => {
  const { c, s, saved } = rig();
  let done = false;
  void s.set("#abcdef").then(() => { done = true; });
  s.flush();
  await c.tick(0);
  assert.deepEqual(saved.map((x) => [x.hex, x.keepalive]), [["#abcdef", true]]);
  assert.ok(done);
  s.flush();
  assert.equal(saved.length, 1, "nothing waiting, nothing sent");
  void s.set(null);
  await c.tick(5000);
  assert.deepEqual(saved.at(-1), { hex: null, at: 5000, keepalive: false }, "null clears it (the picker's default)");
});

test("the picker goes through it (and so does an owner plugin's profile file — app/(owner)/_terminal/dm.test.ts): the local store and refresh event first, the save later", async () => {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    let storageEvents = 0;
    dom.window.addEventListener("storage", () => { storageEvents++; });
    void setOwnColor("#123456");
    assert.equal(dom.window.localStorage.getItem("chatUsernameColor"), "#123456", "on the page at once");
    assert.ok(storageEvents >= 1, "the readers were told");
    assert.deepEqual(calls, [], "not saved yet — coalesced");
    void setOwnColor("#654321");
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [{ url: "/api/me/color", method: "PATCH", body: { color: "#654321" } }], "one save, the newest, on the way out");
    const { readFileSync } = await import("node:fs");
    const { stripComments } = await import("./testSource.ts");
    const editor = stripComments(readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8"));
    assert.match(editor, /setOwnColor\(hex\)/, "the picker uses it");
    assert.equal(editor.includes('"/api/me/color"'), false, "and has no save of its own");
    assert.match(editor, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor: the END of the editor was read");
  } finally {
    globalThis.fetch = realFetch;
  }
});
