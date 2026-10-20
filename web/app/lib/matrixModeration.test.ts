// Power tiers, capability checks and the wording of a fan-out result.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/matrixModeration.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  powerTier, canKick, canBan, isBannedIn, moderationSummary,
  type ModRoom, type RoomOutcome, type SiteOutcome,
} from "./matrixModeration.ts";

// A room whose power_levels demand `need` for both kick and ban, with the
// given members. Mirrors the SDK's RoomState.hasSufficientPowerLevelFor.
function room(need: number, members: Record<string, { powerLevel: number; membership?: string }>): ModRoom {
  return {
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= need },
    getMember: (id: string) => members[id] ?? null,
  };
}

test("a room creator's Infinity power reads as Owner with no number", () => {
  const tier = powerTier(Infinity);
  assert.equal(tier.label, "Owner");
  assert.equal(tier.showNumber, false);
});

test("100 is Admin, 50 is Moderator, 0 is Member — singular", () => {
  assert.equal(powerTier(100).label, "Admin");
  assert.equal(powerTier(50).label, "Moderator");
  assert.equal(powerTier(0).label, "Member");
  assert.equal(powerTier(0).showNumber, true);
});

test("tier rank orders owner above admin above moderator above member", () => {
  const ranks = [Infinity, 100, 50, 0].map((pl) => powerTier(pl).rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(new Set(ranks).size, 4);
});

test("capability reads the ROOM's own level, not a hard-coded 50", () => {
  // A room that demands 75 must refuse a power-50 moderator.
  const strict = room(75, { "@mod:site.test": { powerLevel: 50 } });
  assert.equal(canKick(strict, "@mod:site.test"), false);
  assert.equal(canBan(strict, "@mod:site.test"), false);

  const normal = room(50, { "@mod:site.test": { powerLevel: 50 } });
  assert.equal(canKick(normal, "@mod:site.test"), true);
  assert.equal(canBan(normal, "@mod:site.test"), true);
});

test("a viewer who is not a member of the room can do nothing", () => {
  const r = room(50, {});
  assert.equal(canKick(r, "@stranger:site.test"), false);
  assert.equal(canBan(r, "@stranger:site.test"), false);
});

test("a creator's Infinity power satisfies any requirement", () => {
  const r = room(100, { "@casey:site.test": { powerLevel: Infinity } });
  assert.equal(canBan(r, "@casey:site.test"), true);
});

test("isBannedIn reads the target's membership", () => {
  const r = room(50, { "@bad:site.test": { powerLevel: 0, membership: "ban" } });
  assert.equal(isBannedIn(r, "@bad:site.test"), true);
  assert.equal(isBannedIn(r, "@nobody:site.test"), false);
});

const ok = (id: string, name: string): RoomOutcome => ({ roomId: id, name, status: "ok" });
const failed = (id: string, name: string, error: string): RoomOutcome => ({ roomId: id, name, status: "failed", error });
const noop = (id: string, name: string): RoomOutcome => ({ roomId: id, name, status: "noop" });

test("everything succeeded reads as one plain line", () => {
  const site: SiteOutcome = { attempted: true, ok: true };
  const lines = moderationSummary("ban", [ok("!a", "general"), ok("!b", "politics")], site);
  // Not "Site ban applied." (undersells the reach) and not "Site and platform
  // ban applied." either (overclaims a platform result the code never
  // observes — fanOutBan is fired after the response and never awaited).
  // Say only what each half actually confirms: the site write, and that the
  // platform fan-out was SENT, not that it succeeded (re-review defect #1).
  assert.deepEqual(lines, ["Banned from 2 channels.", "Site ban applied; platform bans sent."]);
});

test("a partial failure names the channels that failed and counts honestly", () => {
  const site: SiteOutcome = { attempted: true, ok: true };
  const lines = moderationSummary(
    "ban",
    [ok("!a", "general"), failed("!b", "politics", "forbidden"), failed("!c", "tech", "forbidden")],
    site
  );
  assert.equal(lines[0], "Banned from 1 of 3 channels.");
  assert.equal(lines[1], "Failed: politics, tech.");
});

test("a room the target was not in counts as done, not as a failure", () => {
  const site: SiteOutcome = { attempted: false, ok: false, reason: "no site account" };
  const lines = moderationSummary("kick", [ok("!a", "general"), noop("!b", "politics")], site);
  assert.equal(lines[0], "Kicked from 2 channels.");
});

test("a skipped site ban says WHY, and a failed one is its own line", () => {
  const skipped = moderationSummary("ban", [ok("!a", "general")], {
    attempted: false, ok: false, reason: "they have no account here",
  });
  assert.equal(skipped[1], "No site ban — they have no account here.");

  const refused = moderationSummary("ban", [ok("!a", "general")], {
    attempted: true, ok: false, reason: "you can't ban the owner",
  });
  assert.equal(refused[1], "Site and platform ban failed: you can't ban the owner.");
});

// Defect #2: moderationSummary used to take a caller-picked verb string and
// hardcode the site line to ban vocabulary regardless, so an UNBAN rendered
// "Unbanned from 20 channels." followed by "Site ban applied." — the opposite
// of what had just happened. These are the cases that were never exercised.
test("an unban reads with unban vocabulary on BOTH halves, not ban's", () => {
  const site: SiteOutcome = { attempted: true, ok: true };
  const lines = moderationSummary("unban", [ok("!a", "general"), ok("!b", "politics")], site);
  assert.deepEqual(lines, ["Unbanned from 2 channels.", "Site unban applied; platform unbans sent."]);
});

test("a failed unban says 'unban', never the ban wording", () => {
  const lines = moderationSummary("unban", [ok("!a", "general")], {
    attempted: true, ok: false, reason: "network error",
  });
  assert.equal(lines[1], "Site and platform unban failed: network error.");
  assert.doesNotMatch(lines[1] ?? "", /\bban failed\b/, "must not read as a BAN failure");
});

test("a skipped unban (no site account) also uses unban wording", () => {
  const lines = moderationSummary("unban", [ok("!a", "general")], {
    attempted: false, ok: false, reason: "they have no account here",
  });
  assert.equal(lines[1], "No site unban — they have no account here.");
});

test("a kick has no site line at all when nothing was attempted and no reason given", () => {
  const lines = moderationSummary("kick", [ok("!a", "general")], { attempted: false, ok: false });
  assert.deepEqual(lines, ["Kicked from 1 channel."]);
});
