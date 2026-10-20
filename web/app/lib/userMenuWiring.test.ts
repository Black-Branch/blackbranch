// Profile-card / user-menu window-event contract.
//
// The account surfaces are opened cross-module through window events, so no
// type system connects a dispatcher to its listener — a renamed event string
// fails silently (the button just stops doing anything). These static checks
// pin each contract: every event that something dispatches has a listener,
// and the hub subscribes to the full set.
//
// Run: node --test app/lib/userMenuWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

/** Comments are not source. A guard that scans raw text passes or fails on
 *  prose — this file's own "do not reintroduce `variant`" comment tripped the
 *  shell check until this existed. Same trap the wsFrames contract guard and
 *  composerLayout both document. */
const readCode = (p: string) => stripComments(read(p));

test("useUserMenuEvents subscribes to the full event set", () => {
  const src = read("app/lib/useUserMenuEvents.ts");
  for (const ev of [
    "bb:open-support",
    "bb:open-store",
    "bb:open-profile-card",
    "bb:open-account-settings",
    "bb:open-chat-appearance",
    "bb:open-modpanel",
    "bb:profile-synced",
    "bb:avatar-changed",
  ]) {
    assert.ok(
      src.includes(`window.addEventListener("${ev}"`),
      `useUserMenuEvents no longer listens for ${ev}`
    );
  }
});

test("UserMenu routes the secure-account nudge to Devices & Security", () => {
  const src = read("app/components/UserMenu.tsx");
  // The nudge (SecureAccountPromptInner) dispatches open-account-settings; the
  // hub must open the card straight onto the security PAGE.
  assert.match(src, /onAccountSettings:\s*\(\)\s*=>\s*open\(PAGES\.security\)/);
  const nudge = read("app/components/SecureAccountPromptInner.tsx");
  assert.ok(nudge.includes("bb:open-account-settings"));
});

test("every account surface is a PAGE of the one card, not its own popup", () => {
  // One card, not several popups across several shells: the failure this
  // pins is a future surface quietly mounting its own overlay again.
  const shells = ["FloatingCard.tsx", "SupportModal.tsx", "ChatAppearancePanel.tsx", "ProfileCard.tsx"];
  for (const f of shells) {
    assert.throws(
      () => read(`app/components/${f}`),
      `${f} is back — every panel goes through the one chrome Window as a page of AccountCard`
    );
  }
  assert.throws(() => read("app/features/store/StoreModal.tsx"));
  assert.throws(() => read("app/features/moderation/ModPanelModal.tsx"));

  // One shell, and it has no mobile branch: a sheet variant makes the card
  // feel wrong on a phone. A matchMedia here is a design regression.
  const shell = readCode("app/components/chrome/Window.tsx");
  assert.ok(!shell.includes("matchMedia"), "Window must not branch on viewport — one card everywhere");
  assert.ok(!/\bvariant\b/.test(shell), "the old shell's per-surface branching is gone; do not reintroduce it");
});

test("the profile card's rows navigate the stack — and the mod row opens the tool window", () => {
  // readCode, not read: the negatives below must not false-red on a COMMENT
  // naming the old mechanism, and the positives must not pass on one either.
  const card = readCode("app/components/ProfileCardBody.tsx");
  for (const page of ["store", "support", "appearance", "security", "accounts", "edit"]) {
    assert.ok(
      card.includes(`onNavigate("${page}")`),
      `the card lost its ${page} row (or went back to dispatching an event for it)`
    );
  }
  // The mod panel is the one deliberate exception: a TOOL window beside the
  // card, not a page of it — the row calls the host's opener so MatrixView's
  // fallback card (which claims no events) still works.
  assert.ok(card.includes("onClick={onOpenMod}"), "the mod row lost its window opener");
  assert.ok(!card.includes('onNavigate("mod")'), "the mod row navigates to a card page that no longer exists");
  const pages = readCode("app/lib/accountPages.ts");
  for (const page of ["store", "support", "appearance", "security", "accounts", "edit"]) {
    assert.ok(pages.includes(`${page}: {`), `accountPages has no "${page}" entry`);
  }
  assert.ok(!pages.includes("mod: {"),
    "accountPages regrew the mod page — the panel is a Window (ModWindow)");
});

test("claimableEvent helper: cancelable dispatch + preventDefault claim", () => {
  // The handshake primitive both openers ride on: dispatchClaimable derives
  // the handled verdict from dispatchEvent's return (false iff a listener
  // preventDefault-ed a cancelable event); claimEvent is that preventDefault.
  const helper = read("app/lib/claimableEvent.ts");
  assert.match(helper, /cancelable:\s*true/, "dispatchClaimable must dispatch a cancelable event");
  assert.match(
    helper,
    /!target\.dispatchEvent\(/,
    "dispatchClaimable must read the handled verdict from dispatchEvent's return value"
  );
  // Both windows go through that one path (with the opener fallback) —
  // claimableEvent.test.ts runs it across two real realms.
  assert.match(helper, /dispatchOn\(window,/, "this window's dispatch no longer goes through dispatchOn");
  assert.match(helper, /dispatchOn\(opener,/, "the opener fallback no longer goes through dispatchOn");
  assert.ok(helper.includes("e.preventDefault()"), "claimEvent must claim via preventDefault()");
});

test("mod-panel handshake: the card's host claims, a user card dispatches", () => {
  // The mod panel opens the ModWindow tool window, and the claimant is
  // whoever hosts the card: it handles open-modpanel. A user card's shield
  // just dispatches (and then closes its own card — UserCard calls onClose
  // after the dispatch); the window opens wherever the claimant hosts it.
  const hub = read("app/lib/useUserMenuEvents.ts");
  const claim = hub.slice(hub.indexOf("const onModPanel"), hub.indexOf("const onProfileCard"));
  assert.ok(
    claim.includes("claimEvent(e)"),
    "useUserMenuEvents must claim open-modpanel via claimEvent()"
  );
  const sidebar = read("app/features/chat/ChatSidebar.tsx");
  assert.match(
    sidebar,
    /dispatchClaimable\("bb:open-modpanel", \{ target \}\)/,
    "the user card's shield must dispatch open-modpanel with its target"
  );
  // ChatSidebar must NOT host it — two hosts means two mod panels.
  assert.ok(
    !sidebar.includes('window.addEventListener("bb:open-modpanel"'),
    "ChatSidebar is no longer the mod-panel host; the account card is"
  );
});

test("profile-card handshake: hub claims, rail dispatches claimable + hosts fallback", () => {
  // Same claimable-event handshake as the mod panel, for the /community rail
  // avatar: on mobile (directory XOR timeline) and on desktop empty states no
  // UserMenu is mounted to listen, so the rail must host its own card when the
  // event goes unclaimed — otherwise the tap is a permanent dead click.
  const hub = read("app/lib/useUserMenuEvents.ts");
  const claim = hub.slice(
    hub.indexOf("const onProfileCard"),
    hub.indexOf("const onAccountSettings")
  );
  assert.ok(
    claim.includes("claimEvent(e)"),
    "useUserMenuEvents must claim open-profile-card via claimEvent()"
  );

  const view = read("app/features/community/MatrixView.tsx");
  assert.match(
    view,
    /const handled = dispatchClaimable\("bb:open-profile-card"\)/,
    "MatrixView must dispatch open-profile-card through dispatchClaimable"
  );
  assert.ok(
    view.includes("<AccountCard"),
    "MatrixView must host its own AccountCard fallback when unclaimed"
  );
  // The duplicate front door stays dead.
  assert.ok(!view.includes("MatrixSettingsModal"));
});

test("the mod window: title in the band, the admin button, 720 floor, both card hosts mount it", () => {
  const winRaw = read("app/features/moderation/ModWindow.tsx");
  assert.ok(winRaw.trimEnd().endsWith("}"), "ModWindow.tsx truncated — pins below are vacuous");
  const win = stripComments(winRaw);
  assert.ok(win.includes('import { Window, BarButton } from "@/app/components/chrome"'), "ModWindow must use the chrome door");
  // The band carries the title; the places are the body's rail.
  assert.ok(win.includes('title="Mod panel"') && !win.includes("tabs={"), "the band shows the title, never a strip");
  assert.ok(win.includes('<BarButton icon={<GearSix size={13} weight="bold" />} label="Admin panel" onClick={() => onOpenAdmin()} />'), "the admin button is a band control");
  assert.ok(win.includes("isAdmin && onOpenAdmin ?"), "the admin button shows to admins only");
  assert.ok(win.includes("minWidth={720}"), "the mod tables' 720 floor is gone (it moved here from PAGE_MIN_W)");
  assert.ok(win.includes('storageKey="bb_modpanel_geom"'), "the window stopped persisting its own geometry");
  // Both hosts — the split-band lesson: a gate copied to a sibling must copy the WHOLE condition.
  assert.ok(readCode("app/components/UserMenu.tsx").includes("<ModWindow"), "UserMenu no longer hosts the mod window");
  assert.ok(readCode("app/components/UserMenu.tsx").includes("{modOpen && ("),
    "UserMenu's mod window lost its open gate");
  assert.ok(readCode("app/features/community/MatrixView.tsx").includes("{modWindowOpen && myUserId && ("),
    "MatrixView's mod window lost its open gate (or its signed-in guard)");
  assert.ok(readCode("app/features/community/MatrixView.tsx").includes("<ModWindow"),
    "MatrixView's fallback host no longer mounts the mod window — its profile card's mod row is a dead click");
  // The admin window rides with the mod window's hosts, gated the same way.
  assert.ok(/\{adminOpen && \(\s*<AdminWindow[\s\S]{0,300}onClose=\{\(\) => \{ setAdminOpen\(false\); setAdminPlace\(undefined\); \}\}/.test(readCode("app/components/UserMenu.tsx")));
  assert.ok(readCode("app/features/community/MatrixView.tsx").includes("{adminWindowOpen && myUserId && <AdminWindow"));
  // /mod is the same window as a page — no bare page of links.
  const page = read("app/(main)/mod/page.tsx");
  assert.match(page, /return <ModPopout place=\{typeof place === "string" && isModPlace\(place\) \? place : undefined\} \/>;/);
  assert.doesNotMatch(page, /<Link|← Back/);
});
