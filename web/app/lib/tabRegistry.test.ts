import { test } from "node:test";
import assert from "node:assert";
import {
  SITE_TABS, isSiteTabKey, readArmed, writeArmed, armTab, closeTab, partitionTabs,
  clampOpen, openAfterClose, DOCK_DEFAULT_ARMED, CHATBAR_DEFAULT_ARMED, splitLeading, armOnce, armFlagKey, isPinnedTab } from "./tabRegistry.ts";

test("registry keys — Home leads, the admin-only Stream tab last", () => {
  assert.deepStrictEqual(SITE_TABS.map((t) => t.key), ["home", "forums", "news", "vods", "stream"]);
  assert.equal(SITE_TABS[0]!.leading, true);
  assert.deepStrictEqual(DOCK_DEFAULT_ARMED, ["home", "forums", "news", "vods", "stream"]);
  assert.deepStrictEqual(CHATBAR_DEFAULT_ARMED, ["home", "news", "stream"]);
});

test("splitLeading keeps each half in registry order", () => {
  const { leading, rest } = splitLeading(SITE_TABS);
  assert.deepStrictEqual(leading.map((t) => t.key), ["home"]);
  assert.deepStrictEqual(rest.map((t) => t.key), ["forums", "news", "vods", "stream"]);
  assert.deepStrictEqual(splitLeading([]).leading, []);
});

test("armOnce: Home is pinned, so arming it once has nothing to do — readArmed already put it back", () => {
  assert.equal(armOnce('["news","vods"]', null, DOCK_DEFAULT_ARMED, "home"), null);
  assert.equal(armOnce(null, null, DOCK_DEFAULT_ARMED, "home"), null);
  assert.equal(armOnce('["news"]', "1", DOCK_DEFAULT_ARMED, "home"), null);
  assert.equal(armOnce("[]", null, CHATBAR_DEFAULT_ARMED, "home"), null);
});

test("the one-time arm flag is per key and per host", () => {
  assert.equal(armFlagKey("home", "dock"), "home_armed_v1:dock");
  assert.equal(armFlagKey("home", "chat"), "home_armed_v1:chat");
  assert.equal(armFlagKey("forums", "dock"), "forums_armed_v1:dock");
});

test("armOnce arms Forums into an existing dock list once", () => {
  assert.equal(armOnce('["news","vods","home"]', null, DOCK_DEFAULT_ARMED, "forums"), '["news","vods","home","forums"]');
  assert.equal(armOnce('["home"]', "1", DOCK_DEFAULT_ARMED, "forums"), null);
});

test("a stored open choice for an unshown Home degrades to the first shown tab", () => {
  assert.equal(clampOpen("home", ["news", "vods"]), "news");
});

test("readArmed: nothing stored → fallback (plus the pinned Home in front)", () => {
  assert.deepStrictEqual(readArmed(null, ["news"]), ["home", "news"]);
});

test("readArmed: invalid JSON → fallback (plus the pinned Home in front)", () => {
  assert.deepStrictEqual(readArmed("not json", ["news", "vods"]), ["home", "news", "vods"]);
});

test("readArmed: unknown keys dropped, dupes collapsed, order kept", () => {
  assert.deepStrictEqual(readArmed('["vods","zeta","vods","news"]', ["news"]), ["home", "vods", "news"]);
});

test("readArmed: an EMPTY stored list is a valid choice, not a fallback case — only the pinned Home remains", () => {
  assert.deepStrictEqual(readArmed("[]", ["news"]), ["home"]);
});

test("readArmed keeps keys the host cannot currently show (persistence ≠ display)", () => {
  // "vods" with zero vods loaded: still stored; the HOST filters for display.
  assert.deepStrictEqual(readArmed('["news","vods"]', []), ["home", "news", "vods"]);
});

test("arm/close", () => {
  assert.deepStrictEqual(armTab(["news"], "vods"), ["news", "vods"]);
  assert.deepStrictEqual(armTab(["news"], "news"), ["news"]);
  assert.deepStrictEqual(closeTab(["news", "vods"], "news"), ["vods"]);
});

test("Home is pinned: readArmed puts it back IN FRONT, closeTab refuses it, a stored Home keeps its place", () => {
  assert.deepStrictEqual(readArmed('["news","vods"]', []), ["home", "news", "vods"], "a device that closed Home gets it back");
  assert.deepStrictEqual(readArmed('["news","home"]', []), ["news", "home"], "a stored Home keeps the user's order");
  assert.deepStrictEqual(closeTab(["home", "news"], "home"), ["home", "news"]);
  assert.deepStrictEqual(closeTab(["home", "news"], "news"), ["home"]);
  assert.equal(isPinnedTab("home"), true);
  assert.equal(isPinnedTab("news"), false);
});

test("isSiteTabKey is the one narrowing point for untrusted strings", () => {
  assert.ok(isSiteTabKey("news"));
  assert.ok(!isSiteTabKey("schedule"), "a key not in SITE_TABS is not a tab key");
  for (const v of [null, undefined, 7, {}, ["news"]]) {
    assert.ok(!isSiteTabKey(v), `${JSON.stringify(v)} is not a tab key`);
  }
});

// ── partitionTabs ────────────────────────────────────────────────────────────
// The split every host needs. The two ORDERS below are different on purpose
// and a host depends on each: `shown` is the user's arming order (shown[0] is
// the open-choice fallback), `tabs` is registry order (a row that does not
// reshuffle as tabs come and go).

test("partitionTabs: shown keeps ARMED order, the drawn row keeps REGISTRY order", () => {
  const p = partitionTabs(["vods", "news"], { home: true, forums: true, news: true, vods: true, stream: false });
  assert.deepStrictEqual(p.shown, ["vods", "news"], "shown follows the user's arming order");
  assert.deepStrictEqual(p.tabs.map((t) => t.key), ["news", "vods"], "the row follows SITE_TABS");
  assert.deepStrictEqual(p.unarmed.map((t) => t.key), ["home", "forums"], "a ready, unarmed Home and Forums are offered by +");
});

test("partitionTabs: an armed-but-not-ready tab is not drawn and not re-offered", () => {
  // Persistence ≠ display. "vods" stays armed (readArmed kept it) but with no
  // vods loaded it is neither in the row nor back in the + picker — offering
  // it there would let the user "add" a tab that cannot appear.
  const p = partitionTabs(["news", "vods"], { home: false, forums: false, news: true, vods: false, stream: false });
  assert.deepStrictEqual(p.shown, ["news"]);
  assert.deepStrictEqual(p.tabs.map((t) => t.key), ["news"]);
  assert.deepStrictEqual(p.unarmed, []);
});

test("partitionTabs: the + picker offers exactly the ready, unarmed tabs", () => {
  assert.deepStrictEqual(
    partitionTabs(["news"], { home: false, forums: false, news: true, vods: true, stream: false }).unarmed.map((t) => t.key), ["vods"],
  );
  assert.deepStrictEqual(
    partitionTabs(["news"], { home: false, forums: false, news: true, vods: false, stream: false }).unarmed, [],
  );
  assert.deepStrictEqual(
    partitionTabs([], { home: true, forums: true, news: true, vods: true, stream: false }).unarmed.map((t) => t.key), ["home", "forums", "news", "vods"],
  );
});

test("partitionTabs: closing a key from `shown` equals re-partitioning without it", () => {
  // BottomDock's onCloseTab relies on this to avoid a second readiness pass
  // that could drift from the first.
  const ready = { home: true, forums: true, news: true, vods: true, stream: false };
  const armed = ["vods", "news"] as const;
  assert.deepStrictEqual(
    closeTab(partitionTabs(armed, ready).shown, "vods"),
    partitionTabs(closeTab(armed, "vods"), ready).shown,
  );
});

test("the Stream tab is never drawn, offered or kept open for a host that is not an admin's", () => {
  const notAdmin = { home: true, forums: true, news: true, vods: true, stream: false };
  const p = partitionTabs(DOCK_DEFAULT_ARMED, notAdmin);
  assert.ok(!p.tabs.some((t) => t.key === "stream"), "drawn for a non-admin");
  assert.ok(!p.unarmed.some((t) => t.key === "stream"), "offered by + to a non-admin");
  assert.ok(!p.shown.includes("stream"));
  assert.equal(clampOpen("stream", p.shown), p.shown[0], "a stored open Stream falls to a shown tab");
  const admin = partitionTabs(DOCK_DEFAULT_ARMED, { ...notAdmin, stream: true });
  assert.ok(admin.tabs.some((t) => t.key === "stream"), "an admin's dock draws it by default");
  assert.equal(armOnce('["home","news"]', null, CHATBAR_DEFAULT_ARMED, "stream"), '["home","news","stream"]', "an existing admin device gets it once");
});

test("both hosts answer Stream's readiness with is_admin, arm it once only for an admin, and mount it only for one", () => {
  const dock = readSrc("app/components/BottomDock/index.tsx");
  const chat = readSrc("app/features/chat/ChatSidebar.tsx");
  assert.match(dock, /stream: isAdmin,/);
  assert.match(chat, /stream: isAdmin && !isPopout,/);
  for (const src of [dock, chat]) {
    assert.match(src, /if \(!isAdmin \|\| streamArmFlag === "1"\) return;/, "the one-time arm runs for a non-admin");
    assert.match(src, /armOnce\([a-zA-Z]+, streamArmFlag, [A-Z_]+, "stream"\)/);
  }
  assert.match(dock, /shownTab === "stream" && isAdmin && \(/);
  assert.match(chat, /k === "stream" && paneMounted\("stream"\) && isAdmin && streamPaneEl/);
  assert.match(chat, /contentTab === "stream" && isAdmin && streamPaneEl/);
  assert.match(readSrc("app/components/StreamView.tsx"), /<BottomDock[\s\S]{0,400}isAdmin=\{isAdmin\}/);
});

test("clampOpen", () => {
  assert.strictEqual(clampOpen("news", ["news", "vods"]), "news");
  assert.strictEqual(clampOpen("news", ["vods"]), "vods"); // open tab no longer shown → first shown
  assert.strictEqual(clampOpen("news", []), null);
  assert.strictEqual(clampOpen(null, ["news"]), null);     // collapsed stays collapsed
});

test("openAfterClose", () => {
  assert.strictEqual(openAfterClose("news", "news", ["vods"]), "vods");
  assert.strictEqual(openAfterClose("news", "vods", ["news"]), "news");
  assert.strictEqual(openAfterClose("news", "news", []), null);
  assert.strictEqual(openAfterClose(null, "news", ["vods"]), null);
});

test("round-trip", () => {
  assert.deepStrictEqual(readArmed(writeArmed(["vods"]), ["news"]), ["home", "vods"]);
});

// ── Host scans (cycle 6b guard tests) ────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "./testSource.ts";

const readSrc = (rel: string) =>
  stripComments(fs.readFileSync(path.join(process.cwd(), rel), "utf8"));

test("every registry key is guard-rendered by BOTH hosts (add a tab → add its guards)", () => {
  // The chat host has TWO render paths (the desktop/split branch and the
  // phone pager), and the census enumerates BOTH — the whole point of a census
  // is that a new registry key cannot be forgotten in a corner, and a second
  // path is a second corner. The at-rest guard is the original contract
  // (`contentTab === "key"`, the desktop/split branch); the pager row's is the
  // WIDENED half — active OR within one pane of a live motion (tabRegistry.ts's
  // contract comment) — which is why it carries `paneMounted("key")` as well
  // as its own literal key term. BottomDock has one path, one guard.
  const dock = readSrc("app/components/BottomDock/index.tsx");
  const chat = readSrc("app/features/chat/ChatSidebar.tsx");
  for (const { key } of SITE_TABS) {
    assert.ok(dock.includes(`shownTab === "${key}" &&`), `dock lacks a literal unmount guard for ${key}`);
    assert.ok(chat.includes(`contentTab === "${key}" &&`), `chat bar lacks a literal unmount guard for ${key}`);
    assert.ok(chat.includes(`k === "${key}" && paneMounted("${key}") &&`),
      `the chat pager row lacks a literal approach-mount guard for ${key}`);
  }
});

test("hosts derive their row through partitionTabs, never by re-filtering SITE_TABS", () => {
  // Two hosts each carrying the same four filters over SITE_TABS with a
  // hand-spelled `k !== "vods" ||` availability clause is two spellings of
  // one rule, and they drift (one bar requiring a picker callback, the other
  // not). partitionTabs is the single spelling, and its
  // TabReadiness argument is exhaustive over SiteTabKey, so a new tab cannot
  // be silently treated as always-available: the host stops compiling.
  for (const rel of ["app/components/BottomDock/index.tsx", "app/features/chat/ChatSidebar.tsx"]) {
    const src = readSrc(rel);
    assert.ok(/from "@\/app\/lib\/tabRegistry"/.test(src), `${rel} must import the registry`);
    assert.ok(src.includes("partitionTabs("), `${rel} must split its tabs via partitionTabs`);
    assert.ok(!src.includes("SITE_TABS"),
      `${rel} re-filters SITE_TABS by hand again — that is the drift partitionTabs replaced`);
  }
});

test("nothing outside the registry widens a tab key back to string", () => {
  // The dock carried its own `DockTabKey = string` from cycle 5, written
  // before the registry existed. Keeping it after cycle 6b bought nothing and
  // cost three `as SiteTabKey` casts — each one a spot where the compiler
  // stopped checking a tab key, in the exact code a new tab has to touch.
  for (const rel of [
    "app/lib/dockState.ts",
    "app/components/BottomDock/index.tsx",
    "app/features/chat/ChatSidebar.tsx",
    "app/features/chat/ChatTabBar.tsx",
  ]) {
    const src = readSrc(rel);
    assert.ok(!/\bas SiteTabKey\b/.test(src), `${rel} casts to SiteTabKey — type the source instead`);
    assert.ok(!/\bDockTabKey\b/.test(src), `${rel} revived DockTabKey; keys are the registry's`);
  }
});

test("the in-player vods tab is gone", () => {
  const sv = readSrc("app/components/StreamView.tsx");
  assert.ok(/useState<PlayerState\["tab"\]>/.test(sv), "the player tab is no longer the player model's tab type");
  assert.ok(/tab: "live" \| "community" \| "replay" \| FallbackId;/.test(readSrc("app/lib/playerSource.ts")), "player tab union shrank");
  assert.ok(!sv.includes('setTab("vods")'), "no path re-enters an in-player vods tab");
});

test("armed sets persist through the registry helpers (no hand-rolled JSON)", () => {
  for (const rel of ["app/components/BottomDock/index.tsx", "app/features/chat/ChatSidebar.tsx"]) {
    const src = readSrc(rel);
    assert.ok(src.includes("readArmed("), `${rel} reads via readArmed`);
    assert.ok(src.includes("writeArmed("), `${rel} writes via writeArmed`);
  }
});

test("neither host draws a ✕ on a pinned tab — every closable is computed, never the literal true", () => {
  const dock = readSrc("app/components/BottomDock/index.tsx");
  const bar = readSrc("app/features/chat/ChatTabBar.tsx");
  assert.match(dock, /closable: !isPinnedTab\(t\.key\)/);
  assert.equal((bar.match(/closable: !isPinnedTab\(t\.key\)/g) ?? []).length, 2, "leading AND rest rows");
  assert.doesNotMatch(dock, /closable: true/);
  assert.doesNotMatch(bar, /closable: true/);
  assert.match(bar, /\}\s*$/); // END anchor
});
