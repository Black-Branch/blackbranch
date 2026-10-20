import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./testSource.ts";

// ── Who is allowed to hold the Matrix CLIENT, and who only needs an ID ───────
//
// A signed-in viewer who never opens the community should not be running a
// matrix-js-sdk client, a RustCrypto WASM instance and a perpetual /sync
// long-poll. That is only true if nothing *outside* the community feature
// needs the client object for something the session already answers.
//
// Surfaces that need only a user id or a signed-in boolean — a nudge card, an
// own-message check, a "which Matrix apps can I use" hint — are on the
// identity tier (useMatrixIdentity), which reads the site session and nothing
// else.
//
// The failure mode this guards is someone adding a new client consumer.
// `client?.getUserId()` is the obvious way to answer "who am I?" when the
// client is right there in context, and every such call silently re-couples a
// cheap surface to the most expensive subsystem in the app. So the allowlist
// below is the intent, the scan derives what is actually true, and the two
// are compared. Adding a client consumer outside features/community is a
// deliberate act with a reason written down, or it fails here.

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");

/**
 * Modules outside `app/features/community/` that may hold the client itself,
 * each with what it genuinely needs from it. Anything answerable by an id or a
 * signed-in boolean does NOT belong here — it belongs on useMatrixIdentity.
 */
const CLIENT_BOUND: Record<string, string> = {
  "lib/MatrixClientContext.tsx": "defines the context and both tiers",
  "lib/useMatrixSettings.ts": "crypto-api: device list, cross-signing, verification flows",
  "lib/useEncryptionStatus.ts": "cross-signing trust state for the nav dot",
  "lib/useChatSplitView.ts": "RoomEvent.Timeline subscription for the unseen-activity dot",
  "lib/useHiddenIgnoreSync.ts": "writes m.ignored_user_list + account data to match the Behavior hide list; mounted by ChatSidebar, which already holds the client via useChatSplitView",
  "components/SecureAccountPrompt.tsx": "real crypto state — whether this account is secured",
  "components/MatrixInput.tsx": "uploads and sends events to a room",
  "components/PresenceBeat.tsx": "reads the client's sync status to know the community view is live — not answerable by useMatrixIdentity's id/signed-in boolean",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = sourceFiles(APP).map((abs) => ({
  rel: relative(APP, abs).split("\\").join("/"),
  src: stripComments(readFileSync(abs, "utf8")),
}));

test("only genuinely client-bound modules use the Matrix client outside the community feature", () => {
  const found = FILES.filter(
    (f) => !f.rel.startsWith("features/community/") && /\buseMatrixClient\b/.test(f.src),
  ).map((f) => f.rel);

  const unexpected = found.filter((f) => !(f in CLIENT_BOUND));
  assert.deepEqual(
    unexpected,
    [],
    `these hold the whole Matrix client outside features/community.\n` +
      `If the module only needs a user id or a signed-in boolean, use useMatrixIdentity — ` +
      `holding the client keeps a /sync long-poll and RustCrypto alive for it.\n` +
      `If it genuinely needs the client object, add it to CLIENT_BOUND with the reason.`,
  );

  // And the other direction: an allowlist entry for a module that no longer
  // uses the client is a stale licence for re-coupling.
  const stale = Object.keys(CLIENT_BOUND).filter((f) => !found.includes(f));
  assert.deepEqual(stale, [], "CLIENT_BOUND entries whose module no longer uses the client");
});

test("the identity-only surfaces read the session, not the client", () => {
  // The seven decoupled in cycle 4. Named explicitly — a regression here is
  // silent (the surface still renders, it just needs the client again).
  const IDENTITY_ONLY = [
    "components/MatrixAppsHint.tsx",
    "components/MatrixAppsList.tsx",
    "components/UserCard.tsx",
    "components/UserMenu.tsx",
    "lib/useContentSuggestion.ts",
  ];
  for (const rel of IDENTITY_ONLY) {
    const f = FILES.find((x) => x.rel === rel);
    assert.ok(f, `${rel} not found — renamed? update this list`);
    assert.match(f.src, /\buseMatrixIdentity\b/, `${rel} should read the identity tier`);
    assert.doesNotMatch(f.src, /\buseMatrixClient\b/, `${rel} must not hold the client`);
    assert.doesNotMatch(
      f.src,
      /client\??\.getUserId\(\)/,
      `${rel} must not derive its id from the client`,
    );
  }
});

test("the identity tier does not depend on the client having started", () => {
  const ctx = FILES.find((f) => f.rel === "lib/MatrixClientContext.tsx")!.src;

  // matrixId comes from the session endpoint, not from the SDK.
  assert.match(ctx, /fetchMatrixId/, "identity is resolved by its own session read");
  assert.match(ctx, /\/api\/auth\/session/, "…from the site session");

  // The identity effect must not be gated on a token or on startClient: those
  // are the client's lifecycle, and coupling to either re-creates the problem.
  const effect = ctx.slice(ctx.indexOf("fetchMatrixId().then"));
  assert.ok(effect.length > 0, "identity effect not found");
  const body = effect.slice(0, effect.indexOf("}, []);"));
  assert.doesNotMatch(body, /startClient|fetchFreshToken/, "identity must not await the client");

  // startClient shares that one session read rather than issuing a second.
  assert.doesNotMatch(
    ctx.slice(ctx.indexOf("const startClient")),
    /fetch\("\/api\/auth\/session"\)/,
    "startClient should reuse fetchMatrixId, not re-fetch the session",
  );
});

test("profile reconcile fires on identity, not on first sync", () => {
  const ctx = FILES.find((f) => f.rel === "lib/MatrixClientContext.tsx")!.src;
  // The route does its Matrix work server-side with the session's own token, so
  // it never needed a synced browser client — only a signed-in user. Left on
  // the sync handler it would simply stop happening for anyone who does not
  // open the community.
  const syncHandler = ctx.slice(ctx.indexOf("ClientEvent.Sync,"), ctx.indexOf("startClient({"));
  assert.doesNotMatch(syncHandler, /reconcileProfile/, "reconcile must not be sync-gated");
  const identityEffect = ctx.slice(ctx.indexOf("fetchMatrixId().then"));
  assert.match(
    identityEffect.slice(0, identityEffect.indexOf("}, []);")),
    /reconcileProfile/,
    "reconcile should fire once identity is known",
  );
});

test("the client is not started on page load", () => {
  const ctx = FILES.find((f) => f.rel === "lib/MatrixClientContext.tsx")!.src;
  // The provider still fetches a token at mount — that request is where an
  // upstream revocation is detected, and dropping it would defer sign-out to
  // whenever the user next opened the community, which for most viewers is
  // never. What it must NOT do any more is start the client off the back of it.
  const mountEffect = ctx.slice(ctx.indexOf("fetchFreshToken()\n      .then"));
  const body = mountEffect.slice(0, mountEffect.indexOf("}, []);"));
  assert.ok(body.length > 0, "mount token effect not found");
  assert.match(body, /setStatus\("notoken"\)/, "it should still resolve the signed-out state");
  assert.doesNotMatch(
    body,
    /startClient\(\)/,
    "page load must not start the Matrix client — that is the whole point of cycle 4",
  );
});

test("only real community/crypto intent starts the client", () => {
  // The tempting regression is adding this to something widely mounted to
  // "make the encryption dot work". That would silently restore the
  // perpetual /sync for every signed-in viewer while looking like a bugfix.
  const STARTERS: Record<string, string> = {
    "lib/MatrixClientContext.tsx": "defines the hook",
    "features/community/MatrixView.tsx": "the single mount point for every community surface",
    "components/MatrixSettings.tsx": "Devices & Security is about the Matrix session itself",
    "features/community/ForumActionHost.tsx": "a forum post or reply from the Forums tab is deliberate intent; it mounts only on that click",
  };
  const found = FILES.filter((f) => /\buseStartMatrixClient\b/.test(f.src)).map((f) => f.rel);
  assert.deepEqual(
    found.filter((f) => !(f in STARTERS)),
    [],
    "these start the Matrix client. Only surfaces a user reaches by deliberate " +
      "intent may — add it to STARTERS with a reason, or use useMatrixIdentity.",
  );
  assert.deepEqual(
    Object.keys(STARTERS).filter((f) => !found.includes(f)),
    [],
    "STARTERS entries that no longer start the client",
  );
});

test("the always-mounted crypto surfaces answer WITHOUT starting the client", () => {
  // These sit in the chat bar and the app layout — mounted for every signed-in
  // viewer. Starting the client to answer "is encryption set up?" would begin
  // /sync, the crypto stores and the unread traffic for someone who never opened
  // the community. That constraint has not moved.
  for (const rel of ["lib/useEncryptionStatus.ts", "components/SecureAccountPrompt.tsx"]) {
    const f = FILES.find((x) => x.rel === rel);
    assert.ok(f, `${rel} not found`);
    assert.doesNotMatch(f.src, /\buseStartMatrixClient\b/, `${rel} must not start the client`);
  }

  // WHAT AN UNKNOWN VERDICT RENDERS AS, and the two halves below must move
  // together.
  //
  // Unknown reads as red, because the row's text ("Encryption needs setup")
  // and the indicator must agree — no dot beside that text would assert a
  // state the indicator declines to show.
  //
  // That is only honest because the verdict is REMEMBERED: a device that has
  // been set up reports green from localStorage long before the client is
  // ready. Remove the memory and the red becomes a false red that tells a
  // user who already set encryption up to do it again on every load — so the
  // memory is asserted here, next to the colour that depends on it.
  const enc = FILES.find((f) => f.rel === "lib/useEncryptionStatus.ts")!.src;
  const dotFn = enc.slice(enc.indexOf("export function encryptionDotClass"));
  assert.match(
    dotFn.slice(0, dotFn.indexOf("\n}")),
    /:\s*"bg-red-400";/,
    "an unknown verdict must fall through to red — the row already says 'needs setup'",
  );
  assert.match(
    enc, /readRememberedVerdict\(/,
    "the hook no longer seeds from the remembered verdict — every set-up user " +
    "will be shown a red dot and told to redo their encryption setup",
  );
  assert.match(
    enc, /rememberVerdict\(/,
    "a computed verdict is never written back, so the memory can only ever be empty",
  );
});

test("a failed session read is not cached as signed-out", () => {
  const ctx = FILES.find((f) => f.rel === "lib/MatrixClientContext.tsx")!.src;
  const fn = ctx.slice(ctx.indexOf("async function fetchMatrixId"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  // Caching the null from a network blip would render every identity-gated
  // surface as signed-out for the life of the page, unreachable without a reload.
  assert.match(
    body,
    /catch\s*{[^}]*inFlightIdentity\s*=\s*null/,
    "the catch must clear the memo so a later caller retries",
  );
});
