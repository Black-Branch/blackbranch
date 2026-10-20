import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

// The root layout's <body> is `h-app overflow-hidden` (app/layout.tsx) because
// the main site is a fixed-viewport app shell. Anything rendered OUTSIDE
// app/(main)/ inherits that, so a DOCUMENT-shaped page — one whose content can
// grow past the fold — must bring its own scroll container or it is silently
// clipped: no scrollbar, no wheel, no way to reach whatever is below the fold.
//
// Nothing else in the suite would notice, because nothing here renders at a
// viewport size. This scan is the cheap stand-in for that.
//
// Run: node --test app/lib/documentPageScroll.test.ts

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// Pages whose content legitimately grows past the fold. Each maps to the file
// that owns its outermost element — for /donate that is the client component,
// not the server page, which only passes props through.
const DOCUMENT_PAGES: Record<string, string> = {
  "/donate": "../donate/DonateClient.tsx",
  "/billing/return": "../billing/return/page.tsx",
};

// Deliberately NOT in the list above: app/chat, app/popout and app/overlay are
// fixed-viewport by design (a chat UI, a widget, an OBS source). Giving those a
// scroll container would be the defect, not the fix.
const FIXED_VIEWPORT_BY_DESIGN = ["chat", "popout", "overlay"];

test("every document-shaped page outside (main) owns a scroll container", () => {
  // Vacuity anchors: this assertion is about presence, but an empty or
  // mis-pathed list would make the loop below check nothing at all.
  assert.ok(
    Object.keys(DOCUMENT_PAGES).length >= 2,
    "the document-page list is too short to be the real one — did a path move?",
  );

  for (const [route, file] of Object.entries(DOCUMENT_PAGES)) {
    const url = new URL(file, import.meta.url);
    assert.ok(existsSync(url), `${route}: ${file} does not exist — update this scan, do not delete it`);
    const src = readFileSync(url, "utf8");
    assert.ok(
      /overflow-y-auto|overflow-auto|overflow-scroll/.test(src),
      `${route} has no scroll container, and <body> is overflow-hidden — its content is clipped at the fold with no way to scroll`,
    );
  }
});

test("the body really is overflow-hidden — the premise of the test above", () => {
  // If this ever stops being true, the scan above is enforcing a rule that no
  // longer exists and should be reconsidered rather than blindly satisfied.
  const layout = read("../layout.tsx");
  assert.ok(
    /<body[\s\S]{0,200}overflow-hidden/.test(layout),
    "the root <body> is no longer overflow-hidden — re-examine whether document pages still need their own scroll container",
  );
  assert.ok(
    FIXED_VIEWPORT_BY_DESIGN.length === 3,
    "the fixed-viewport exclusion list changed — confirm the new page is genuinely meant not to scroll",
  );
});
