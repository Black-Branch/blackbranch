// The two install traps around the site's URL: next-auth's own URL, and the WebSocket URL.
// Run: node --test app/lib/authUrl.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyAuthUrl } from "./authUrl.ts";
import { streamApiWsUrl } from "./streamApi.ts";

test("no AUTH_URL: next-auth gets the site's origin", () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(applyAuthUrl(env, "https://example.tv"), "site.origin");
  assert.equal(env.AUTH_URL, "https://example.tv");
});

test("an env that names one keeps it", () => {
  const env: Record<string, string | undefined> = { AUTH_URL: "https://example.tv" };
  assert.equal(applyAuthUrl(env, "https://other.example"), "env");
  assert.equal(env.AUTH_URL, "https://example.tv");
  const legacy: Record<string, string | undefined> = { NEXTAUTH_URL: "https://example.tv" };
  assert.equal(applyAuthUrl(legacy, "https://other.example"), "env");
  assert.equal(legacy.AUTH_URL, undefined);
  const blank: Record<string, string | undefined> = { AUTH_URL: "  " };
  assert.equal(applyAuthUrl(blank, "https://example.tv"), "site.origin", "a blank value names nothing");
  assert.equal(applyAuthUrl({}, ""), "none");
});

test("the boot applies it before serving (instrumentation register)", () => {
  const src = readFileSync(new URL("../../instrumentation.ts", import.meta.url), "utf8");
  const apply = src.indexOf("applyAuthUrl(process.env)");
  assert.ok(apply > 0, "instrumentation.ts no longer applies the sign-in URL");
  const publish = src.indexOf("publishInstallValues()");
  assert.ok(publish > 0 && apply > publish, "it must run after the install values are published — it reads site.origin from them");
});

test("F-WSURL: the internal socket is STREAM_API_WS_URL, else STREAM_API_URL with ws", () => {
  assert.equal(streamApiWsUrl({ STREAM_API_WS_URL: "ws://10.0.0.5:4000", STREAM_API_URL: "http://127.0.0.1:3001" }), "ws://10.0.0.5:4000");
  assert.equal(streamApiWsUrl({ STREAM_API_URL: "http://127.0.0.1:3001/" }), "ws://127.0.0.1:3001");
  assert.equal(streamApiWsUrl({ STREAM_API_URL: "https://api.example.tv" }), "wss://api.example.tv");
  assert.equal(streamApiWsUrl({}), "");
});
