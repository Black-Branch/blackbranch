// Tests for the automod hold queue's wiring (static, node --test).
//
// A hold queue that nobody notices lets every hold expire unreviewed. That is a
// visibility failure, so what is worth pinning is the visibility, not the fetch:
//   • one poller, one store — two surfaces must not disagree about what's pending
//   • the inline bar is a SIBLING of the scroll container, so it can't scroll away
//   • it never polls for non-mods (an invisible component that still fetches)
//   • it renders nothing when the queue is empty
//   • a transient fetch failure doesn't read as "nothing held"
//
// Run: node --test app/lib/automodQueue.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

// Comments are not source — this file's own prose names what it bans.

const hook = stripComments(read("app/lib/useAutomodQueue.ts"));
const bar = stripComments(read("app/components/AutomodHoldBar.tsx"));
const section = stripComments(read("app/features/moderation/sections/AutomodSection.tsx"));
const sidebar = stripComments(read("app/features/chat/ChatSidebar.tsx"));

test("both surfaces share ONE queue implementation", () => {
  // Two independent pollers would double the load and, worse, let the panel and
  // the inline bar disagree — offering Allow on a hold the other already
  // resolved. Neither surface owns a fetch of its own.
  assert.match(bar, /useAutomodQueue\(/, "the inline bar must use the shared hook");
  assert.match(section, /useAutomodQueue\(/, "the mod panel section must use the shared hook");
  for (const [name, src] of [["bar", bar], ["section", section]] as const) {
    assert.doesNotMatch(
      src,
      /["'`]\/api\/mod\/automod/,
      `${name} fetches the automod API directly instead of going through the hook`
    );
  }
});

test("the poller is a single module-level timer, not one per component", () => {
  assert.match(hook, /const store\b/, "expected a module-level store");
  // `setInterval\(` — the CALL. A bare /setInterval/ also matches the store's
  // `ReturnType<typeof setInterval>` annotation and reports a phantom second timer.
  const intervals = hook.match(/setInterval\(/g) ?? [];
  assert.equal(intervals.length, 1, `expected exactly one poll timer, found ${intervals.length}`);
});

test("non-mods never poll", () => {
  // Gating only the render leaves an invisible component happily fetching a
  // 403 endpoint every few seconds.
  assert.match(hook, /if \(!enabled\) return;/, "the effect must bail out for non-mods");
  assert.match(bar, /useAutomodQueue\(isMod\)/, "the bar must pass its real mod flag, not `true`");
});

test("a failed refresh keeps the last queue instead of blanking it", () => {
  // Blanking on a transient error renders as "nothing held", which is the
  // exact wrong answer for a feature whose entire job is to be noticed.
  // Vacuity guards: `indexOf` returns -1 when an anchor stops matching, and
  // `slice(-1)` is the last character, not "nothing" — without the guards a
  // deleted catch block leaves `katch` as "}" and `doesNotMatch` passes.
  // Removing the catch is the more dangerous edit: the rejection then escapes
  // `void refresh()` as an unhandled rejection and the queue stops updating.
  const rStart = hook.indexOf("async function refresh");
  const rEnd = hook.indexOf("function start");
  assert.ok(rStart !== -1, "refresh() not found in useAutomodQueue — was it renamed?");
  assert.ok(rEnd > rStart, "could not bound refresh()'s body");
  const refresh = hook.slice(rStart, rEnd);

  const cIdx = refresh.indexOf("catch");
  assert.ok(cIdx !== -1,
    "refresh() has NO catch block — a transient /api/mod/automod failure now rejects out " +
    "of `void refresh()` as an unhandled rejection, and the held queue silently stops " +
    "updating. That is the same user-visible bug as blanking it, by a different route.");
  const katch = refresh.slice(cIdx);
  assert.ok(katch.length > 10, "the catch block extracted as nothing — this guard is not guarding");
  assert.doesNotMatch(katch, /store\.held\s*=/, "the catch must not overwrite the queue");
});

test("the inline bar renders nothing when there is nothing held", () => {
  // It must cost zero attention until it deserves all of it.
  assert.match(
    bar,
    /if \(!isMod \|\| !held \|\| pending === 0\) return null;/,
    "the bar must bail out when empty, unknown, or for non-mods"
  );
});

test("the bar is pinned OUTSIDE the chat scroll container", () => {
  // Holds expire in ~5 minutes. A row inside the scroller drifts out of view
  // during a busy stream, which is precisely the failure being prevented.
  //
  // The property is that the bar is a SIBLING of the scroller, not its position
  // above or below the messages. Anchored structurally: PausedPill is the last
  // child of the scroller, so the bar must come after the `</div>` that follows
  // it, and before the composer.
  const barIdx = sidebar.indexOf("<AutomodHoldBar");
  const pausedIdx = sidebar.indexOf("<PausedPill");
  const composerIdx = sidebar.indexOf("ref={composerRef}");
  assert.ok(barIdx !== -1, "the inline bar must be mounted in chat");
  assert.ok(pausedIdx > 0 && composerIdx > 0, "expected the scroller and composer anchors");

  const scrollerCloses = sidebar.indexOf("</div>", pausedIdx);
  assert.ok(scrollerCloses > 0, "could not find the scroll container's closing tag");
  assert.ok(
    barIdx > scrollerCloses,
    "AutomodHoldBar is INSIDE the scroll container — it will scroll away"
  );
  assert.ok(
    barIdx < composerIdx,
    "AutomodHoldBar must sit between the messages and the composer, not below the input"
  );
});

test("resolving removes the row immediately", () => {
  // Up to a full poll of latency on a resolved hold invites a second click,
  // which the API answers with a 410 the mod then has to interpret.
  const resolve = hook.slice(hook.indexOf("const resolve = useCallback"));
  const filterIdx = resolve.indexOf("filter(");
  const postIdx = resolve.indexOf("postJson");
  assert.ok(filterIdx !== -1, "resolve must drop the row locally");
  assert.ok(filterIdx < postIdx, "the optimistic removal must precede the request");
});

test("a review row can reach the user's moderation tools", () => {
  // Allow/Deny/Dismiss are decisions about the MESSAGE; a row that names the
  // person must also offer a way to act on them (a ban, a timeout).
  // Pins the GUARD EXPRESSION, not just the identifier: `/onModerate/` alone is
  // satisfied by `{false && onModerate && (`.
  assert.match(bar, /\{onModerate && \(/, "the Mod button must render whenever the host provides the action");
  assert.match(bar, /onClick=\{\(\) => onModerate\(\{/, "the button must actually invoke it");
  assert.match(sidebar, /onModerate=\{/, "chat must wire the bar's moderate action");

  // Routed to the USER CARD, not the mod panel. The panel's target box runs
  // input through resolveTarget, which builds `@name:site.test` — correct for a
  // site account, wrong for a platform-only chatter, who is exactly the person
  // most likely to be in this queue. The card handles both id shapes.
  assert.match(sidebar, /onModerate=\{[\s\S]{0,600}?openUserCard\(/,
    "moderate must open the user card, which handles canonical-only identities");
  assert.doesNotMatch(sidebar, /onModerate=\{[\s\S]{0,600}?open-modpanel/,
    "routing to the mod panel mis-resolves platform-only chatters");
});

test("allowing an AGE hold actually publishes the message", () => {
  // Blocklist rows are never meant to be delivered and Twitch rows live on
  // Twitch, but an age hold says nothing about the MESSAGE, only that the
  // account could not be vouched for. Marking it "allowed" while silently
  // dropping it turns withhold into block — and the panel promises holds are
  // releasable.
  const resolve = stripComments(read("app/api/mod/automod/resolve/route.ts"));
  // The releasable set holds more than one source (link_gate too) and is a
  // ternary: native rows also release word holds via /chat/native. What stays
  // pinned is that account_age is IN the set on BOTH branches and that the set
  // is guarded on allow + pending — a match on either array alone would be
  // satisfied by one branch.
  const ternary = /RELEASABLE = isNative\s*\?\s*\[([^\]]*)\]\s*:\s*\[([^\]]*)\]/.exec(resolve);
  assert.ok(ternary, "the RELEASABLE ternary is gone from the resolve route");
  assert.match(ternary![1] ?? "", /"account_age"/,
    "age holds are no longer releasable on the native branch");
  assert.match(ternary![2] ?? "", /"account_age"/,
    "age holds are no longer releasable on the platform branch — Allow would silently drop them");
  assert.match(resolve, /RELEASABLE\.includes\(row\.source\) && action === "allow"/,
    "the release must be scoped to releasable holds being ALLOWED");
  assert.match(resolve, /row\.status === "pending"/,
    "a blocked row has nothing to publish — releasing it would deliver a slur");
  assert.match(resolve, /streamApiFetch\("\/chat"/, "it must actually re-publish the message");
  assert.match(resolve, /releaseHold: true/, "and flag it so the age gate does not refuse it again");

  // Publish BEFORE marking resolved — the other order reports success with the
  // message gone and no row left to retry from.
  assert.ok(
    resolve.indexOf("streamApiFetch(\"/chat\"") < resolve.indexOf("SET status = $2"),
    "the release must precede the status write, so a failure leaves the row actionable"
  );
  assert.match(resolve, /release_failed/, "a failed release must not report success");
});

test("the release skips ONLY the age gate, never the blocklist", () => {
  // Defense in depth: a mod releasing a held account must not become a way to
  // publish something the word filter would refuse.
  const chat = stripComments(read("../stream-api/chat.js"));
  assert.match(chat, /releaseHold === true\s*\?\s*\{ action: 'allow' \}/,
    "releaseHold must short-circuit the age check specifically");
  // Pins that classify() is UNCONDITIONAL, not merely present-and-earlier: an
  // indexOf comparison alone stays true for
  // `releaseHold ? {action:'allow'} : classify(message)` — the exact bypass
  // being guarded against.
  assert.match(chat, /^\s*const verdict = classify\(message\);\s*$/m,
    "the blocklist verdict must be computed unconditionally — releaseHold must never skip it");
  assert.ok(
    chat.indexOf("const verdict = classify(message);") < chat.indexOf("releaseHold === true"),
    "the blocklist must still run ahead of the release bypass"
  );
});

test("the queue carries the ids needed to moderate a platform-only chatter", () => {
  // A platform chatter has no matrixId — and they are the ones a raid brings.
  // The canonical id is what the card falls back to for platform-side actions,
  // so dropping it from the payload would silently make those rows unactionable.
  // Scoped to the SELECT clause: the whole file still mentions the columns in
  // the TS row type and the `r.user_id` mapping even when the SELECT drops them.
  // The read lives in automodQueueSql.ts; the route must use it.
  assert.match(stripComments(read("app/api/mod/automod/route.ts")), /AUTOMOD_QUEUE_SQL/, "the route no longer reads the shared queue query");
  const q = stripComments(read("app/lib/automodQueueSql.ts"));
  const sel = q.slice(q.indexOf("SELECT id, twitch_msg_id"), q.indexOf("FROM ("));
  assert.ok(sel.length > 0, "could not find the queue SELECT");
  for (const field of ["matrix_id", "user_id", "platform"]) {
    assert.ok(sel.includes(field), `the queue SELECT must return ${field}`);
  }
  assert.match(bar, /canonicalId: m\.userId/, "the bar must pass the canonical id through");
});

// ─── Deny on a cross-posted native message must reach the ORIGIN ───
//
// A native send fanned out to Twitch can be held by Twitch AutoMod — but the
// hold is only the TWITCH COPY. The site original (and any YouTube/Kick copies)
// already published. A Deny that resolves only the copy Twitch never showed
// leaves the message up everywhere the community actually reads it.

test("a held cross-post is linked back to its origin site message at hold time", () => {
  // Helix returns NO message id for a dropped send, so the link cannot be
  // captured at send time — the EventSub hold handler must do the matching.
  const sub = stripComments(read("app/lib/automodEventSub.ts"));
  const link = sub.slice(sub.indexOf("SET site_msg_id"));
  assert.ok(link.length > 50, "the origin-link UPDATE is gone from the hold handler");
  assert.match(link, /a\.provider = 'twitch'/, "the match must go through the sender's LINKED account");
  assert.match(link, /cm\.message = \$3/, "the match must be on exact text — anything looser links strangers' messages");
  assert.match(link, /now\(\) - interval/, "the match must be recency-bounded");
  assert.match(link, /NOT cm\.is_deleted/, "an already-deleted origin is not a linkable origin");
  assert.match(link, /h\.site_msg_id IS NULL/, "a redelivered hold event must not re-link an already-linked row");
  // The guard, not just the query: an event with no user or text must not run it.
  assert.match(sub, /if \(ev\.user_id && ev\.message\?\.text\)/,
    "the linkage must be gated on the event actually carrying a user and text");
});

test("deny on a linked row deletes the origin — on success AND on genuine expiry, never on failure", () => {
  const resolve = stripComments(read("app/api/mod/automod/resolve/route.ts"));
  assert.match(resolve, /action === "deny" && row\.site_msg_id != null/,
    "the origin delete must be scoped to DENY on a linked row — Allow means the origin stays");

  // Expiry is Twitch DROPPING its copy — it never touched the origin, so a
  // deny that races the 5-minute window still removes it: a delete call must
  // live INSIDE the 404 branch (before its return) as well as on success.
  const helix404 = resolve.indexOf('status === 404');
  const branch404 = resolve.slice(helix404, resolve.indexOf('"expired"', helix404));
  assert.ok(helix404 !== -1, "lost the 404 branch anchor");
  assert.match(branch404, /deleteSiteMessageEverywhere\(mod/,
    "an expired-hold deny no longer removes the origin — the denied message stays up");
  // …but a 404 can ALSO be a concurrent resolve in Twitch's own mod view —
  // including an ALLOW. The branch must re-read the row and refuse when it is
  // no longer pending, or B's deny deletes a message A just approved.
  assert.match(branch404, /SELECT status FROM site\.automod_held/,
    "the 404 branch must re-read the row — without it a raced external ALLOW gets its origin deleted");
  assert.ok(branch404.indexOf("SELECT status") < branch404.indexOf("deleteSiteMessageEverywhere"),
    "the re-read must gate the delete, not follow it");

  // NO delete on twitch_rejected: a 401 from an expired broadcaster token
  // must not half-succeed (origin gone, row still pending, failure toast). The
  // rejected early-return has to come before the success-path delete, with no
  // delete call between the 404 branch and it.
  const rejectedIdx = resolve.indexOf("twitch_rejected");
  const successDelIdx = resolve.indexOf("deleteSiteMessageEverywhere(mod", branch404.length + helix404);
  assert.ok(rejectedIdx !== -1 && successDelIdx !== -1, "lost the rejected/success anchors");
  assert.ok(rejectedIdx < successDelIdx,
    "the origin delete runs before the twitch_rejected return — a failed Helix call deletes the origin anyway");

  // Double-resolve guard: a resolved row is not actionable again.
  assert.match(resolve, /if \(row\.status !== "pending"\)/,
    "a stale second panel can re-deny an already-resolved row");
});

test("the shared delete is idempotent in its side effects", () => {
  // A deny racing a manual mod delete (or a retried resolve) must not
  // re-broadcast, double-log, or re-fire the platform fan-out. The flag UPDATE
  // is the guard: it only matches a still-visible row, and everything else is
  // skipped when it matched nothing.
  const helper = stripComments(read("app/lib/siteMessageDelete.ts"));
  assert.match(helper, /SET is_deleted = true WHERE id = \$1 AND is_deleted = false/,
    "the flag write lost its already-deleted guard");
  const guardIdx = helper.indexOf("if (!rowCount) return");
  // The CALL, not the identifier — the import line also says streamApiFetch.
  const wsIdx = helper.indexOf("await streamApiFetch(");
  assert.ok(guardIdx !== -1, "the early return on an already-deleted row is gone");
  assert.ok(wsIdx !== -1, "lost the broadcast-call anchor");
  assert.ok(guardIdx < wsIdx, "the guard must precede the broadcast/log/fan-out side effects");
});

test("the shared site-message delete performs all four steps, and mod/delete uses it", () => {
  // Four steps: persistence flag, live-view broadcast, mod log, copies fan-out.
  // Missing any one reads as deleted on one surface and present on another.
  const helper = stripComments(read("app/lib/siteMessageDelete.ts"));
  assert.match(helper, /SET is_deleted = true/, "the site flag is what survives a refresh");
  assert.match(helper, /streamApiFetch\(`\/chat\/delete`/, "the live WS view must hear about it");
  assert.match(helper, /appendModLog\(/, "an unlogged delete is invisible mod history");
  assert.match(helper, /fanOutDelete\(/, "the cross-posted platform copies must go too");

  // /api/mod/delete must go THROUGH the helper for native messages — a second
  // hand-rolled copy of the four steps is how one caller drifts from the other.
  // (The route hands it to modDelete.ts, which calls it for a native line after the ceiling.)
  const route = stripComments(read("app/api/mod/delete/route.ts"));
  assert.match(route, /deleteNative: deleteSiteMessageEverywhere,/, "mod/delete must use the shared helper");
  const flow = stripComments(read("app/lib/modDelete.ts"));
  assert.match(flow, /if \(isNativePlatform\(platform\)\) \{\s*await deps\.deleteNative\(mod, Number\(id\)\);\s*return new Response\("OK"\);/);
  assert.doesNotMatch(route + flow, /SET is_deleted/, "mod/delete must not hand-roll the site flag beside the helper");
});

test("both review surfaces disclose the deny blast radius on a cross-post", () => {
  // A mod clicking Deny on a linked row is deleting a message that is already
  // public in three places. The row must say so before the click, not after.
  // The read lives in automodQueueSql.ts; the route must use it.
  assert.match(stripComments(read("app/api/mod/automod/route.ts")), /AUTOMOD_QUEUE_SQL/, "the route no longer reads the shared queue query");
  const q = stripComments(read("app/lib/automodQueueSql.ts"));
  const sel = q.slice(q.indexOf("SELECT id, twitch_msg_id"), q.indexOf("FROM ("));
  assert.ok(sel.includes("site_msg_id"), "the queue SELECT must return the origin link");
  assert.match(bar, /m\.siteMsgId != null/, "the inline bar must gate its cross-post marker on the link");
  assert.match(section, /m\.siteMsgId != null/, "the panel section must gate its cross-post marker on the link");
});
