// Behavior — who "Hide" / "/ignore name" means.
// Run: node --test app/lib/hideTarget.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { personOfMessage, resolveChatter } from "./hideTarget.ts";

const dirOf = (people: { name: string; keys: string[]; matrixId: string | null; publicId: string | null }[]) => ({
  list: people.map((p) => ({ ...p, color: "#fff" })),
  byKey: new Map(people.flatMap((p) => p.keys.map((k) => [k, { ...p, color: "#fff" }] as const))),
});

test("a message's sender: a site line's Matrix id, else the line's per-platform public id — never a canonical", () => {
  assert.deepEqual(personOfMessage({ username: "Bob", publicId: "pSITE", matrixId: "@bob:site.test" }),
    { id: "@bob:site.test", name: "Bob", matrixId: "@bob:site.test" });
  assert.deepEqual(personOfMessage({ username: "bobtw", publicId: "pTWITCH", matrixId: null }),
    { id: "pTWITCH", name: "bobtw", matrixId: null });
  assert.equal(personOfMessage({ username: "ghost", publicId: null, matrixId: null }), null);
});

test("a typed name finds someone in chat by any name they answer to, @ and case ignored", () => {
  const dir = dirOf([{ name: "Bobby McGee", keys: ["bobby mcgee", "bob"], matrixId: "@bob:site.test", publicId: "p1" }]);
  assert.deepEqual(resolveChatter(dir, " @Bob "), { id: "@bob:site.test", name: "Bobby McGee", matrixId: "@bob:site.test" });
  assert.deepEqual(resolveChatter(dir, "bobby mcgee"), { id: "@bob:site.test", name: "Bobby McGee", matrixId: "@bob:site.test" });
  const tw = dirOf([{ name: "kate", keys: ["kate"], matrixId: null, publicId: "pK" }]);
  assert.deepEqual(resolveChatter(tw, "kate"), { id: "pK", name: "kate", matrixId: null });
  assert.equal(resolveChatter(dir, "alice"), null);
  assert.equal(resolveChatter(null, "bob"), null);
  assert.equal(resolveChatter(dir, "  "), null);
});
