// Behavior › Profanity filter: common swear words become asterisks of the same
// length; the message stays.
// Run: node --test app/lib/profanity.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { maskProfanity } from "./profanity.ts";

test("a swear word becomes asterisks of the same length", () => {
  assert.equal(maskProfanity("what the fuck"), "what the ****");
  assert.equal(maskProfanity("oh shit."), "oh ****.");
});

test("any case, and the common endings", () => {
  assert.equal(maskProfanity("FUCKING hell"), "******* hell");
  assert.equal(maskProfanity("shitty bullshit"), "****** ********");
  assert.equal(maskProfanity("you asshole"), "you *******");
  assert.equal(maskProfanity("fucked, fucker, fucks"), "******, ******, *****");
});

test("words that merely contain one stay intact", () => {
  for (const s of ["Scunthorpe", "class", "assess", "cocktail", "shitake? no: shiitake", "hello", "dickens", "grasshopper", "assassin", "passion"]) {
    assert.equal(maskProfanity(s), s, s);
  }
});

test("text with nothing to mask comes back as the same string", () => {
  const s = "a normal message";
  assert.equal(maskProfanity(s), s);
});

test("vacuity: the list is not empty and masks more than one root", () => {
  const hit = ["fuck", "shit", "bitch", "cunt", "dick", "piss", "bastard", "damn"].filter((w) => maskProfanity(w) !== w);
  assert.ok(hit.length >= 7, hit.join(","));
});

test("names and plain words that share a spelling stay", () => {
  for (const s of ["Dick Cheney said", "Moby Dick", "the cock crowed", "a prick of the needle", "Philip K. Dick"]) {
    assert.equal(maskProfanity(s), s, s);
  }
  // …while the unambiguous compounds still go.
  assert.equal(maskProfanity("what a dickhead"), "what a ********");
  assert.equal(maskProfanity("cocksucker"), "**********");
});
