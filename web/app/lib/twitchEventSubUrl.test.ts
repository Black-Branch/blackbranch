// Run: node --test app/lib/twitchEventSubUrl.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVENTSUB_WS_URL, isEventSubReconnectUrl } from "./twitchEventSubUrl.ts";

test("a reconnect_url on Twitch's EventSub host is followed", () => {
  // The shape Twitch documents for session_reconnect.
  assert.equal(isEventSubReconnectUrl("wss://eventsub.wss.twitch.tv?reconnect_id=abc123"), true);
  assert.equal(isEventSubReconnectUrl("wss://eventsub.wss.twitch.tv/ws?reconnect_id=abc"), true);
  assert.equal(isEventSubReconnectUrl(EVENTSUB_WS_URL), true);
});

test("any other address is refused", () => {
  for (const bad of [
    "ws://eventsub.wss.twitch.tv/ws",               // not TLS
    "wss://eventsub.wss.twitch.tv.example.test/ws", // a host that merely starts with Twitch's
    "wss://evil.test/?eventsub.wss.twitch.tv",
    "wss://x.eventsub.wss.twitch.tv/ws",
    "wss://eventsub.wss.twitch.tv:8443/ws",
    Object.assign(new URL(EVENTSUB_WS_URL), { username: "u", password: "p" }).href, // credentials in the URL
    "https://eventsub.wss.twitch.tv/ws",
    "wss://10.0.0.1/ws",
    "not a url", "", undefined, null, 42,
  ]) {
    assert.equal(isEventSubReconnectUrl(bad), false, String(bad));
  }
});

test("automodEventSub follows a reconnect_url only through the check, and otherwise starts fresh", () => {
  const src = readFileSync(new URL("./automodEventSub.ts", import.meta.url), "utf8");
  // Anchor on the end of the file: a short read must not pass.
  assert.match(src, /\n\}\s*$/, "automodEventSub.ts read whole");
  const from = src.indexOf('type === "session_reconnect"');
  const to = src.indexOf('type === "notification"');
  assert.ok(from > 0 && to > from, "the session_reconnect branch was found");
  const branch = src.slice(from, to);
  assert.match(branch, /if \(isEventSubReconnectUrl\(next\)\) \{[^}]*connect\(next, true\);/, "a checked URL is followed as a handoff");
  assert.match(branch, /connect\(EVENTSUB_WS_URL, false\)/, "an unchecked one is replaced by a fresh session");
  // Every connect() call in the file dials the checked URL or the fixed one (plus the definition).
  const args = [...src.matchAll(/\bconnect\(([^,)]+),/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(args)].sort(), ["EVENTSUB_WS_URL", "next", "url: string"]);
});
