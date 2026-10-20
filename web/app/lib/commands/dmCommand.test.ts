// `/dm`, `/message`, `/announce`, `/everyone`, `/dm all`, driven through the REAL command runner
// with fetch stubbed — behaviour, not source.
// Run: node --test app/lib/commands/dmCommand.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "../testTsx.ts"; // resolves run.ts's extensionless and "@/" imports
import { onDmRequest, registerDmHost, type DmRequest } from "../dm/bus.ts";

const { createCommandRunner } = await import("./run.ts");

type Call = { url: string; body: unknown };
function stubFetch(answer: (url: string) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answer(url);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function runner() {
  const out = { errors: [] as (string | null)[], notices: [] as string[] };
  const { runCommand } = createCommandRunner({ setSendError: (m) => out.errors.push(m), showNotice: (t) => out.notices.push(t) });
  return { runCommand, out };
}

const viewer = { isMod: false, isAdmin: false };
const mod = { isMod: true, isAdmin: false };
const person = (u: string) => ({ matrixId: `@${u}:site.test`, username: u, displayName: null });

test("/dm <name> <text>: one match opens the DM window with the text; /message is the same command", async () => {
  const got: DmRequest[] = [];
  const off = onDmRequest((r) => got.push(r));
  const unmount = registerDmHost();
  const calls = stubFetch(() => ({ status: 200, json: { people: [person("casey")] } }));
  const { runCommand, out } = runner();
  assert.deepEqual(await runCommand("/dm casey hello there", viewer), { kind: "handled" });
  assert.deepEqual(await runCommand("/message casey", viewer), { kind: "handled" });
  assert.match(calls[0]!.url, /^\/api\/dm\/resolve\?q=casey$/);
  assert.deepEqual(got, [
    { kind: "open", to: person("casey"), text: "hello there" },
    { kind: "open", to: person("casey"), text: undefined },
  ]);
  assert.deepEqual(out.errors, []);
  unmount(); off();
});

test("/dm <name>: several matches open the picker; none says so and opens nothing", async () => {
  const got: DmRequest[] = [];
  const off = onDmRequest((r) => got.push(r));
  const unmount = registerDmHost();
  stubFetch((url) => ({ status: 200, json: { people: url.includes("cas") ? [person("casey"), person("cassidy")] : [] } }));
  const { runCommand, out } = runner();
  await runCommand("/dm cas hi", viewer);
  await runCommand("/dm nobody", viewer);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { kind: "pick", query: "cas", people: [person("casey"), person("cassidy")], text: "hi" });
  assert.deepEqual(out.errors.filter(Boolean), ["No one else here goes by nobody."]);
  unmount(); off();
});

test("/dm when signed out, or with no chat column to open in, says why", async () => {
  stubFetch(() => ({ status: 401, json: {} }));
  const a = runner();
  await a.runCommand("/dm casey", viewer);
  assert.deepEqual(a.out.errors.filter(Boolean), ["Sign in to send direct messages."]);
  stubFetch(() => ({ status: 200, json: { people: [person("casey")] } }));
  const b = runner();
  await b.runCommand("/dm casey", viewer); // no DmHost registered
  assert.deepEqual(b.out.errors.filter(Boolean), ["Direct messages open in the chat panel — send it from there."]);
});

test("/announce, /everyone, /dm all and /dm everyone are refused for a viewer before any request", async () => {
  const calls = stubFetch(() => ({ status: 200, json: { ok: true } }));
  const { runCommand } = runner();
  for (const line of ["/announce hi all", "/everyone hi all"]) {
    assert.deepEqual(await runCommand(line, viewer), { kind: "rejected", message: "That command is for mods." }, line);
  }
  for (const line of ["/dm all hi", "/dm everyone hi", "/message @all hi"]) {
    assert.deepEqual(await runCommand(line, viewer), { kind: "rejected", message: "Announcements are for mods." }, line);
  }
  assert.equal(calls.length, 0, "nothing reached the server (which refuses anyway — /api/mod/announce is requireMod)");
});

test("a mod's /announce, /everyone, /dm all and /message everyone all post the text to /api/mod/announce", async () => {
  const calls = stubFetch(() => ({ status: 200, json: { ok: true } }));
  const { runCommand, out } = runner();
  for (const line of ["/announce stream in 5", "/everyone stream in 5", "/dm all stream in 5", "/message everyone stream in 5"]) {
    assert.deepEqual(await runCommand(line, mod), { kind: "handled" }, line);
  }
  assert.deepEqual(calls.map((c) => [c.url, c.body]), Array(4).fill(["/api/mod/announce", { text: "stream in 5" }]));
  assert.equal(out.notices.length, 4);
  assert.deepEqual(await runCommand("/dm all", mod), { kind: "rejected", message: "Missing <message> — /announce <message>" });
});

test("an announcement over the limit is refused client-side; a 429 is said plainly", async () => {
  const calls = stubFetch(() => ({ status: 429, json: {} }));
  const { runCommand, out } = runner();
  await runCommand(`/announce ${"x".repeat(301)}`, mod);
  assert.equal(calls.length, 0);
  await runCommand("/announce hi", mod);
  assert.deepEqual(out.errors.filter(Boolean), ["An announcement is at most 300 characters.", "One announcement every 30 seconds."]);
});
