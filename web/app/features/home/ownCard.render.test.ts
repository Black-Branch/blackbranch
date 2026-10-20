import "../../lib/testTsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "../../lib/testSource.ts";

// ProfileCardBody needs a matrix identity from context and the profile cache;
// the render contract is pinned by source scan (the component is the account
// card's own, unchanged), and HomeView's use of it by a render.
test("OwnCard mounts the account card's own ProfileCardBody and routes its rows through the hub", () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/OwnCard.tsx"), "utf8"));
  assert.match(src, /import ProfileCardBody from "@\/app\/components\/ProfileCardBody"/);
  assert.match(src, /useMatrixIdentity\(\)/);
  assert.match(src, /<ProfileCardBody\b/);
  for (const [key, event] of [
    ["security", "bb:open-account-settings"],
    ["accounts", "bb:open-linked-accounts"],
    ["appearance", "bb:open-chat-appearance"],
    ["support", "bb:open-support"],
    ["store", "bb:open-store"],
  ]) {
    assert.ok(src.includes(`${key}: "${event}"`), `row ${key} → ${event}`);
  }
  assert.match(src, /if \(key === "edit"\) return onEdit\(\)/);
  assert.match(src, /dispatchClaimable\("bb:open-modpanel"\)/);
  assert.match(src, /foldRows\s*\/>/);
  assert.ok(src.trimEnd().endsWith("}"), "END anchor");
});

test("HomeView signed in renders the left column with the card, not the sign-in pitch", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { HomeView } = await import("./HomeView.tsx");
  const html = renderToStaticMarkup(createElement(HomeView, {
    data: null, loading: true, error: false, active: false, signedIn: true, variant: "grid",
    selectedVodId: null, onPickVod: () => {}, onWatchCommunity: () => {}, onOpenNews: () => {},
  }));
  assert.ok(!html.includes("<header"), "signed in: no pitch header");
  assert.ok(html.includes('data-home-left="card"'), "the left column is the card slot");
  assert.ok(html.includes("md:grid-cols-[minmax(240px,300px)_1fr]"), "two columns when signed in too");
});
