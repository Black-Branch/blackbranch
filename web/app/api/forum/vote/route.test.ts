// Source scan: who WROTE a forum post decides whose social credit a vote moves,
// so the author must come from a server we run, never from one the voter names.
//
// The route used to ask the VOTER's homeserver (session.homeserver) for the
// event and trust its `sender`. A viewer signed in from a homeserver they
// control could answer any event id with `sender` set to someone on ours (each
// −1 costing that person credit) or to themselves (self-vote farming). The
// author now comes only from the forum reader: our homeserver, the reader's
// service token, and only for a room the reader discovered as a forum — its
// behaviour (null for a room outside the forum set, the sender inside it) is
// pinned by forumReader.test.ts's sender() test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);
const post = src.slice(src.indexOf("export async function POST"));

test("the vote route never asks the voter's homeserver who wrote a post", () => {
  assert.ok(post.length > 0 && src.includes("export async function POST"), "the POST handler was found");
  assert.doesNotMatch(src, /session\.homeserver/, "the event is read from the voter's own homeserver");
  assert.doesNotMatch(src, /session\.accessToken/, "the voter's token is used for the author lookup");
  assert.doesNotMatch(src, /safeFetch|readJsonCapped|\bfetch\(/, "the route makes its own outbound read for the author");
});

test("the author comes only from the forum reader, and no author means no vote", () => {
  const assigns = [...post.matchAll(/\bauthor\s*=(?!=)/g)].map((m) => post.slice(m.index!, m.index! + 60));
  assert.ok(assigns.length >= 1, "the author is assigned");
  for (const a of assigns) {
    assert.match(a, /^author\s*=\s*await forumReader\.sender\(roomId, eventId\)/, `author set from somewhere else: ${a}`);
  }
  const lookup = post.indexOf("forumReader.sender(roomId, eventId)");
  const write = post.indexOf("INSERT INTO site.forum_votes");
  assert.ok(lookup > 0 && write > lookup, "the reader lookup runs before any vote is written");
  assert.match(post.slice(lookup, write), /if \(!author\) return new Response\("Not Found", \{ status: 404 \}\);/,
    "an event the reader cannot place in a forum room is refused before a write");
  assert.match(post.slice(lookup, write), /ForumReaderUnavailable/, "a reader with no token answers 503, not a vote");
});

test("the header no longer claims a misattribution is impossible without saying why", () => {
  assert.doesNotMatch(raw, /the client API returns the event \+ its sender/, "the old comment describes the voter-homeserver read");
  assert.match(raw, /never from the voter's homeserver/i);
  // END anchor: the scan reached the handler's last response.
  assert.ok(post.lastIndexOf("return Response.json({ score") > post.indexOf("forumReader.sender"), "the read reached the route's end");
  assert.match(src, /\}\s*$/);
});
