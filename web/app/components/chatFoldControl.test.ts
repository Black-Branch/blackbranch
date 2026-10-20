import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../lib/testSource.ts";

const bar = stripComments(readFileSync(join(process.cwd(), "app/features/chat/ChatTabBar.tsx"), "utf8"));
const sidebar = stripComments(readFileSync(join(process.cwd(), "app/features/chat/ChatSidebar.tsx"), "utf8"));
const view = stripComments(readFileSync(join(process.cwd(), "app/components/StreamView.tsx"), "utf8"));

test("the chat bar carries a Fold chat button in its trailing group, before Community mode", () => {
  assert.match(bar, /onFoldChat\?: \(\) => void;/);
  // `|| termButton`: the terminal's `>_` shares the lane (chatTabBar.test.ts).
  assert.match(bar, /\|\| !!onToggleFull \|\| !!onFoldChat \|\| termButton;/);
  const fold = bar.indexOf('label="Fold chat"');
  const full = bar.indexOf("onToggleFull && (() =>");
  assert.ok(fold > 0 && full > fold, "Fold chat renders before the full toggle");
  assert.match(bar, /\{onFoldChat && \(\s*<BarButton icon=\{<CaretDoubleRight size=\{13\} weight="bold" \/>\} label="Fold chat" onClick=\{onFoldChat\} \/>\s*\)\}/);
  assert.ok(bar.trimEnd().endsWith("}"), "END anchor");
});

test("ChatSidebar forwards onFoldChat to its one ChatTabBar mount (the folded-bar pill is not a bar)", () => {
  assert.match(sidebar, /onFoldChat\?: \(\) => void;/);
  assert.equal((sidebar.match(/onFoldChat=\{onFoldChat\}/g) ?? []).length, 1);
  const bar = sidebar.slice(sidebar.indexOf("<ChatTabBar"), sidebar.indexOf("/>", sidebar.indexOf("<ChatTabBar")));
  assert.match(bar, /onFoldChat=\{onFoldChat\}/);
  assert.ok(sidebar.trimEnd().endsWith("}"), "END anchor");
});

test("StreamView folds through applyMode on desktop only, and the way back is an always-visible edge tab", () => {
  assert.match(view, /onFoldChat=\{narrow \? undefined : \(\) => applyMode\("chatFolded"\)\}/);
  assert.match(view, /\{!narrow && \(panelMode === "theatre" \|\| panelMode === "chatFolded"\) && \(/);
  const tab = view.slice(view.indexOf('title="Show chat"') - 400, view.indexOf('title="Show chat"') + 600);
  assert.match(tab, /aria-label="Show chat"/);
  // Always visible ONLY for a folded chat; theatre (video alone) keeps the
  // proximity reveal.
  assert.match(tab, /panelMode === "chatFolded" \? "opacity-60 hover:opacity-100" : "opacity-0 group-hover\/chatedge:opacity-100"/);
  assert.match(tab, /w-6 z-40 group\/chatedge/);
  assert.match(tab, /<CaretLeft size=\{12\} weight="bold" \/>/);
  // StreamView's last statement is the guest-donate dynamic import, not a closing brace.
  assert.ok(view.trimEnd().endsWith('{ ssr: false });'), "END anchor");
});
