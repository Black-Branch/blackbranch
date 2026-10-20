// The loader is the reason a blocked script is a non-event. Its whole job is
// to answer "is the API usable right now?" SYNCHRONOUSLY at mount time, so a
// player never waits on a script an ad blocker already killed.
// Run: node --test app/lib/playerScripts.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScriptLoader, SCRIPT_URL, SCRIPT_TIMEOUT_MS } from "./playerScripts.ts";

type FakeScript = { src: string; onload: (() => void) | null; onerror: (() => void) | null };

/** A DOM stand-in that records what was appended and lets a test resolve it. */
function fakeEnv() {
  const scripts: FakeScript[] = [];
  const win: Record<string, unknown> = {};
  let now = 0;
  const env = {
    win,
    appendScript(src: string, onload: () => void, onerror: () => void) {
      const s: FakeScript = { src, onload, onerror };
      scripts.push(s);
    },
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1]!.cancelled = true; },
  };
  const timers: { fn: () => void; at: number; cancelled?: boolean }[] = [];
  return {
    env, scripts, win,
    /** Fire the script's load handler. Optionally publish its global immediately,
     *  as a fully-usable API (a `Player` constructor) unless `shape` overrides it. */
    succeed(i = 0, globalName?: string, shape: unknown = { Player: function Player() {} }) {
      if (globalName) win[globalName] = shape;
      scripts[i]!.onload!();
    },
    /** Publish a global after onload has fired, to test the poll. Defaults to a
     *  usable shape; pass `shape` to publish YouTube's pre-widget stub
     *  (`{ loading: 1 }`, no `Player`) and prove the poll does not stop there. */
    publishGlobal(globalName: string, shape: unknown = { Player: function Player() {} }) {
      win[globalName] = shape;
    },
    fail(i = 0) { scripts[i]!.onerror!(); },
    advance(ms: number) {
      now += ms;
      // Keep draining timers until none are due, because the poll re-registers itself.
      while (true) {
        const due = timers.find(t => !t.cancelled && t.at <= now);
        if (!due) break;
        due.cancelled = true;
        due.fn();
      }
    },
  };
}

test("ready() is false before anything is loaded — a player must not wait to find out", () => {
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  assert.equal(loader.ready("youtube"), false);
  assert.equal(loader.ready("twitch"), false);
});

test("a loaded script makes ready() true", async () => {
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const p = loader.load("twitch");
  f.succeed(0, "Twitch");
  assert.equal(await p, true);
  assert.equal(loader.ready("twitch"), true);
});

test("A BLOCKED SCRIPT RESOLVES FALSE — it never rejects and never hangs", async () => {
  // An ad blocker kills these scripts for a real slice of the audience. If
  // this path threw or hung, playback would be affected by an enhancement.
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const p = loader.load("twitch");
  f.fail(0);
  assert.equal(await p, false);
  assert.equal(loader.ready("twitch"), false);
});

test("onload fires but global never appears — times out as failed", async () => {
  // YouTube's iframe_api fires load but the real widget API has not yet
  // defined window.YT. If the poll does not poll, this waits forever.
  // This test proves the poll actually fires; unconditionally calling finish(true)
  // on onload would pass all other tests.
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const p = loader.load("youtube");
  f.succeed(0); // Fire onload, but do NOT publish window.YT
  f.advance(SCRIPT_TIMEOUT_MS + 1);
  assert.equal(await p, false);
});

test("onload fires without global but global appears later — poll detects it", async () => {
  // YouTube's real widget API defines window.YT sometime after iframe_api loads.
  // The poll must detect it and resolve before the deadline.
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const p = loader.load("youtube");
  f.succeed(0); // Fire onload, but do NOT publish window.YT
  f.advance(100); // Let the poll run once
  f.publishGlobal("YT");
  f.advance(100); // Let the poll detect the global
  assert.equal(await p, true);
  assert.equal(loader.ready("youtube"), true);
});

test("FINDING 1: the namespace existing is not enough — YT.Player must be a function", async () => {
  // YouTube's loader-of-a-loader: window.YT = { loading: 1 } appears well
  // before the real widget script defines YT.Player. A `ready()` that only
  // checked for the namespace would go true in that window, and
  // `new YT.Player(...)` would throw into the caller's try/catch.
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const p = loader.load("youtube");
  f.succeed(0, "YT", { loading: 1 }); // onload fires; only the loader stub exists
  f.advance(100); // let the poll run at least once
  assert.equal(loader.ready("youtube"), false, "ready() went true before YT.Player existed");
  f.publishGlobal("YT", { loading: 1, Player: function Player() {} }); // the real widget API arrives
  f.advance(100);
  assert.equal(await p, true);
  assert.equal(loader.ready("youtube"), true);
});

test("loading twice appends ONE script and both callers get the same answer", async () => {
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const a = loader.load("twitch");
  const b = loader.load("twitch");
  f.succeed(0, "Twitch");
  assert.equal(await a, true);
  assert.equal(await b, true);
  assert.equal(f.scripts.length, 1, "the same API was requested twice and fetched twice");
});

test("a failure is remembered — we do not re-fetch a script the browser refused", async () => {
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const first = loader.load("twitch");
  f.fail(0);
  await first;
  assert.equal(await loader.load("twitch"), false);
  assert.equal(f.scripts.length, 1);
});

test("the two sources are independent", async () => {
  const f = fakeEnv();
  const loader = createScriptLoader(f.env as never);
  const yt = loader.load("youtube");
  const tw = loader.load("twitch");
  f.fail(0);
  f.succeed(1, "Twitch");
  assert.equal(await yt, false);
  assert.equal(await tw, true);
  assert.equal(loader.ready("twitch"), true);
  assert.equal(loader.ready("youtube"), false);
});

test("appendScript throwing synchronously — a CSP block — resolves false", async () => {
  // A CSP violation or hardened DOM can throw before any callback fires.
  // A blocked script is a non-event; load() must resolve false, not reject.
  const win: Record<string, unknown> = {};
  const env = {
    win,
    appendScript() { throw new Error("CSP violation"); },
    now: () => 0,
    setTimeout: () => 1,
    clearTimeout: () => {},
  } as never;
  const loader = createScriptLoader(env);
  const p = loader.load("youtube");
  assert.equal(await p, false);
  assert.equal(loader.ready("youtube"), false);
});

test("the script URLs are the documented ones", () => {
  assert.equal(SCRIPT_URL.youtube, "https://www.youtube.com/iframe_api");
  assert.equal(SCRIPT_URL.twitch, "https://embed.twitch.tv/embed/v1.js");
});
