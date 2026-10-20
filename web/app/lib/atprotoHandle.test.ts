// Run: node --test app/lib/atprotoHandle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidHandle, normalizeHandle } from "./atprotoHandle.ts";

test("accepts real atproto handles", () => {
  for (const h of [
    "alice.bsky.social",
    "casey.weston.io",
    "a.co",
    "sub.domain.example.com",
    "has-hyphens.example.org",
    "digits123.example.net",
  ]) assert.equal(isValidHandle(h), true, h);
});

test("rejects IP literals — the direct SSRF payload", () => {
  for (const h of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "0.0.0.0"]) {
    assert.equal(isValidHandle(h), false, h);
  }
});

test("rejects single-label names (localhost and friends)", () => {
  for (const h of ["localhost", "router", "postgres"]) {
    assert.equal(isValidHandle(h), false, h);
  }
});

test("rejects anything carrying a scheme, port, path, query or credentials", () => {
  for (const h of [
    "http://example.com",
    "example.com:5432",
    "example.com/path",
    "example.com?a=b",
    "user@example.com",
    "example.com#frag",
    "exa mple.com",
    "example.com\\evil",
  ]) assert.equal(isValidHandle(h), false, h);
});

test("rejects malformed labels", () => {
  for (const h of [
    "",
    ".",
    ".example.com",
    "example..com",
    "example.com.",          // trailing dot -> empty final label
    "-lead.example.com",
    "trail-.example.com",
    `${"a".repeat(64)}.com`, // label over 63
    `${"a.".repeat(130)}com`, // total over 253
  ]) assert.equal(isValidHandle(h), false, JSON.stringify(h));
});

test("normalizeHandle strips @, trims and lowercases", () => {
  assert.equal(normalizeHandle("  @Alice.BSky.Social "), "alice.bsky.social");
  assert.equal(normalizeHandle("plain.example.com"), "plain.example.com");
});

test("normalize then validate is the intended pairing", () => {
  // Uppercase is legal user input but not a legal label — normalizing first is
  // what makes it pass, so the route must do both in that order.
  assert.equal(isValidHandle("Alice.BSky.Social"), false);
  assert.equal(isValidHandle(normalizeHandle("@Alice.BSky.Social")), true);
});
