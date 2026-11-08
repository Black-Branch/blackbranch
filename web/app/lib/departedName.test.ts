// A member who has left or been banned keeps the name and picture they last had (client polish
// Task 21, item 7a's name half). Their current member event is the ban or the leave, which
// carries no displayname or avatar_url, so the SDK sets rawDisplayName to the full user id and
// getMxcAvatarUrl to nothing. The event's previous content (the join) still holds both.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/departedName.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import type { RoomMember } from "matrix-js-sdk";

const { memberName, memberAvatar } = await import("./matrixDisplay.ts");

const ID = "@casey_77:site.test";

function departed(membership: "ban" | "leave" | "join", prev: Record<string, unknown> | undefined, now: Record<string, unknown> = {}) {
  return {
    userId: ID,
    membership,
    // What the SDK writes for a member event without a displayname (room-member.ts).
    rawDisplayName: typeof now.displayname === "string" ? now.displayname : ID,
    getMxcAvatarUrl: () => (typeof now.avatar_url === "string" ? now.avatar_url : undefined),
    events: { member: { getPrevContent: () => prev ?? {} } },
  } as unknown as RoomMember;
}

test("a ban member event with a prior displayname → the prior name", () => {
  assert.equal(memberName(departed("ban", { membership: "join", displayname: "Casey" }), ID), "Casey");
  assert.equal(memberName(departed("leave", { membership: "join", displayname: "Casey" }), ID), "Casey");
});

test("with none → the localpart, never the full id", () => {
  assert.equal(memberName(departed("ban", undefined), ID), "casey_77");
  assert.equal(memberName(departed("ban", { membership: "join" }), ID), "casey_77");
  // A previous name that is itself an id is no name either (Task 9's rule).
  assert.equal(memberName(departed("ban", { membership: "join", displayname: "@other:site.test" }), ID), "casey_77");
  // No events at all (a fixture, an old member object): still the localpart.
  assert.equal(memberName({ userId: ID, rawDisplayName: ID } as unknown as RoomMember, ID), "casey_77");
});

test("prior avatar kept", () => {
  assert.equal(memberAvatar(departed("ban", { membership: "join", avatar_url: "mxc://site.test/abc" })), "mxc://site.test/abc");
  assert.equal(memberAvatar(departed("leave", { membership: "join", avatar_url: "mxc://site.test/abc" })), "mxc://site.test/abc");
  assert.equal(memberAvatar(departed("ban", { membership: "join" })), null);
  // Only an mxc URL is a picture.
  assert.equal(memberAvatar(departed("ban", { membership: "join", avatar_url: "https://x.test/a.png" })), null);
  assert.equal(memberAvatar(null), null);
});

test("a joined member who cleared their own name or picture does not get the old one back", () => {
  // Only a departure (ban or leave) borrows from the previous event: someone still here who
  // removed their name chose that, and the old one must not come back.
  const cleared = departed("join", { membership: "join", displayname: "Casey", avatar_url: "mxc://site.test/abc" });
  assert.equal(memberName(cleared, ID), "casey_77");
  assert.equal(memberAvatar(cleared), null);
  // A current name and picture always win over the previous ones.
  const renamed = departed("ban", { displayname: "Old" }, { displayname: "New", avatar_url: "mxc://site.test/new" });
  assert.equal(memberName(renamed, ID), "New");
  assert.equal(memberAvatar(renamed), "mxc://site.test/new");
});
