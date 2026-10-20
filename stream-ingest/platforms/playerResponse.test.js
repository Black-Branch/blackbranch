// Regression for the ytInitialPlayerResponse extractor.
// Run: node --test platforms/playerResponse.test.js
//
// The old lazy regex /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;(?:\s*var\b|...)/
// stopped at the FIRST `};var` in the page. That sequence can legitimately appear
// inside a JSON string (a video title or description), which truncated the JSON,
// failed the parse, and returned null — indistinguishable from "the stream ended".
// A video title was enough to take the YouTube connector offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerResponse } from './youtube.js';

const wrap = (json) => `<script>var ytInitialPlayerResponse = ${json};var meta = {};</script>`;

test('parses a normal player response', () => {
  const out = parsePlayerResponse(wrap('{"videoDetails":{"isLive":true,"title":"hello"}}'));
  assert.equal(out?.videoDetails?.isLive, true);
});

test('survives "};var" inside a string value (the truncation bug)', () => {
  const title = 'patch notes };var hack';
  const out = parsePlayerResponse(wrap(JSON.stringify({ videoDetails: { isLive: true, title } })));
  assert.ok(out, 'must not return null — that reads as "stream ended"');
  assert.equal(out.videoDetails.title, title);
  assert.equal(out.videoDetails.isLive, true);
});

test('survives braces and escaped quotes inside strings', () => {
  const title = 'a {nested} \\" quote } and { brace';
  const out = parsePlayerResponse(wrap(JSON.stringify({ videoDetails: { isLive: false, title } })));
  assert.ok(out);
  assert.equal(out.videoDetails.title, title);
});

test('handles deep nesting without truncating', () => {
  const deep = { a: { b: { c: { d: { e: 'x' } } } }, videoDetails: { isLive: true } };
  const out = parsePlayerResponse(wrap(JSON.stringify(deep)));
  assert.equal(out?.a?.b?.c?.d?.e, 'x');
  assert.equal(out?.videoDetails?.isLive, true);
});

test('returns null when the key is absent or the object never closes', () => {
  assert.equal(parsePlayerResponse('<script>var nope = 1;</script>'), null);
  assert.equal(parsePlayerResponse('var ytInitialPlayerResponse = {"a":{"b":1}'), null);
});
