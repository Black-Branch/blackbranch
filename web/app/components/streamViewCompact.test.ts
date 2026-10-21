import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../lib/testSource.ts";

const view = stripComments(readFileSync(join(process.cwd(), "app/components/StreamView.tsx"), "utf8"));
const dock = stripComments(readFileSync(join(process.cwd(), "app/components/BottomDock/index.tsx"), "utf8"));
const globals = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

test("desktop compact parks the bars but keeps the dock; only theatre fills the column", () => {
  assert.match(view, /const fillMode = panelMode === "theatre" \|\| \(narrow && !bars\.barsInFlow\);/);
  assert.match(view, /const barsParked = !narrow && barsHidden && panelMode !== "theatre";/);
  assert.match(view, /bb-video-col @container flex flex-col min-w-0 flex-none md:flex-1 \$\{barsParked \? "bars-parked" : ""\}/);
  assert.match(view, /\{!narrow && panelMode !== "theatre" && \(\s*<BottomDock/);
  assert.match(view, /barsOverlay=\{barsParked\}/);
  // StreamView's last statement is the guest-donate dynamic import, not a closing brace.
  assert.ok(view.trimEnd().endsWith("{ ssr: false });"), "END anchor");
});

test("the dock's tab row becomes an overlay Bar and stops counting against the content", () => {
  assert.match(dock, /barsOverlay: boolean;/);
  assert.match(dock, /const rowPx = barsOverlay \? 0 : tabRowPx;/);
  assert.match(dock, /const avail = contentAvail\(leftoverPx, rowPx\);/);
  assert.match(dock, /const visible = dockShown\(openTab, leftoverPx, rowPx, view === "hidden"\);/);
  assert.match(dock, /<Bar\s+slot="top"\s+name="dock"\s+band\s+overlay=\{barsOverlay\}\s+background=\{barsOverlay \? "var\(--glass-bg\)" : undefined\}/);
  // The drag handle stays ABOVE the overlay bar (z-30), or the revealed row
  // covers it and the video/dock split can no longer be dragged.
  assert.match(dock, /className="group\/fdrag absolute top-0 inset-x-0 h-3 z-40 /);
  assert.ok(dock.trimEnd().endsWith("}"), "END anchor");
});

test("a parked column reserves only the frame borders for chrome, so the attached video keeps the dock's space", () => {
  assert.match(globals, /\.bb-video-col\.bars-parked \{ --video-chrome: calc\(2 \* var\(--frame-width, 2px\)\); \}/);
  assert.ok(globals.trimEnd().endsWith("}"), "END anchor");
});
