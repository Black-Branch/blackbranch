// The signed-out surface.
//
// Three ways the site can fail a visitor who hasn't signed in:
//
// 1. A community centre pane that treats `notoken` and `error` like
//    `loading` shows a signed-out visitor "Joining community…" forever —
//    a spinner-shaped dead end with no sign-in CTA anywhere in the feature.
//    (Chat gets this right: its composer becomes the CTA when signed out.)
//
// 2. The About/Privacy links must be always-visible (Google OAuth
//    verification) — not inside the meta row, which is showMeta-gated,
//    collapsed by default and `inert` while folded. The guarantee lives in
//    the chat panel's signed-out CTA row, which IS on the anonymous page.
//
// 3. The sign-in page sits inside an app shell whose body is h-dvh
//    overflow-hidden — mod/page.tsx documents the rule: the page wrapper
//    must be the scroll container (`h-full overflow-y-auto`) or short
//    viewports just clip (`min-h-screen` does not do it). It also uses the
//    palette tokens, not hardcoded colours, has a way back to the home page,
//    and does not lead with "Sign in with Matrix" — jargon to the new visitor
//    the page exists for.
//
// Run: node --test app/lib/signedOutSurface.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

test("the community pane's signed-out state is a sign-in CTA, not a forever-spinner", () => {
  const src = readWhole(
    "app/features/community/MatrixView.tsx",
    /return <UnifiedLayout pageChrome \/>;\s*}\s*$/,
  );
  assert.match(src, /status === "notoken"[\s\S]{0,400}href="\/auth\/signin"/,
    'signed out (`notoken`), the centre pane must offer a sign-in link — without one, ' +
    '"Joining community…" renders forever and the feature has no funnel back in');
  assert.match(src, /status !== "ready" \? \([\s\S]{0,400}<BootSequence[^>]*onRetry=\{retry\}/,
    "`error` must render its own state with a way out — the boot sequence's failed stage carries " +
    "the retry (L3); folding a failure into loading text told a user whose client failed to keep " +
    "waiting for something that would never arrive");
});

test("the anonymous chat panel carries the About and Privacy links", () => {
  const src = readWhole("app/features/chat/ChatSidebar.tsx", /<\/aside>\s*\)\s*;\s*}\s*$/);
  const signedOutBlock = src.match(/Sign in to chat[\s\S]{0,900}/)?.[0] ?? "";
  assert.match(signedOutBlock, /href="\/about"/,
    "the signed-out CTA row lost its About link — the anonymous home page must explain " +
    "itself on a surface that is on screen signed out");
  assert.match(signedOutBlock, /href="\/legal#privacy"/,
    "the signed-out CTA row lost its Privacy link — the anonymous home page must link the " +
    "privacy policy (Google OAuth verification)");
});

test("the sign-in page is its own scroll container", () => {
  const src = readWhole("app/(main)/auth/signin/SignInForm.tsx", /<\/div>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /h-full overflow-y-auto/,
    "the app shell disables document scroll (body is h-dvh overflow-hidden), so the page " +
    "wrapper must scroll or short viewports clip the form — the rule mod/page.tsx documents");
  assert.doesNotMatch(src, /min-h-screen/,
    "min-h-screen sizes against a viewport the shell doesn't let the document scroll");
});

test("the sign-in page uses design-system tokens, not hardcoded palette colors", () => {
  const src = readWhole("app/(main)/auth/signin/SignInForm.tsx", /<\/div>\s*\)\s*;\s*}\s*$/);
  for (const cls of ["bg-white", "text-black", "bg-gray-", "text-gray-"]) {
    assert.ok(!src.includes(cls),
      `sign-in page uses hardcoded \`${cls}\` — the 24-token system covers this ` +
      "(bg-strong/text-on-accent for the primary button); hardcoded colors ignore theming");
  }
});

test("the sign-in page offers a way back and drops the Matrix jargon", () => {
  const src = readWhole("app/(main)/auth/signin/SignInForm.tsx", /<\/div>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /href="\/"/,
    "no link back to the home page — a visitor who lands here by accident is stranded");
  assert.ok(!src.includes("Sign in with Matrix"),
    'the primary button said "Sign in with Matrix" — jargon to the new visitor this page ' +
    "exists for; the protocol belongs in the federated section, not the main CTA");
});
