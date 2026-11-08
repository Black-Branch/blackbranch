// The player debug log's remount line, RUN: a real component using the real hook
// is mounted, unmounted and mounted again, and the row the sink receives is read
// the way prod's site.client_errors reads it.
//
// Parked P17: the 10-29 → 11-01 rows had the player remounting in two tabs at
// once with no tap, and the row said only "remount (#4)". It now names what the
// player is keyed on that changed since its last life.
//
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/features/player/playerDebugRemount.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { React, act, dom } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { usePlayerDebug } = await import("@/app/features/player/usePlayerDebug");
const { _resetClientErrorThrottle } = await import("@/app/lib/clientError");
const { PLAYER_MODE_KEY } = await import("@/app/lib/playerMode");
const { createRoot } = await import("react-dom/client");

const rows: string[] = [];
(globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
  if (String(url).startsWith("/api/client-error")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { source?: string; message?: string };
    if (body.source === "player") rows.push(body.message ?? "");
  }
  return Promise.resolve(new Response(null, { status: 204 }));
};

// The switch is on for this "device" before the log is first created.
dom.window.localStorage.setItem("player_debug", "1");

type Inputs = Record<string, string>;
function Box({ src, inputs }: { src: string; inputs: Inputs }) {
  const ref = React.useRef<HTMLDivElement>(null);
  usePlayerDebug(ref, src, inputs);
  return React.createElement("div", { ref });
}

const host = dom.window.document.createElement("div");
dom.window.document.body.appendChild(host);
const root = createRoot(host);
const show = async (inputs: Inputs | null) => {
  await act(async () => { root.render(inputs ? React.createElement(Box, { src: inputs.src ?? "none", inputs }) : null); });
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
};
const lastRemount = () => [...rows].reverse().find((r) => r.startsWith("player debug: remount")) ?? "";
// The sink drops a repeat message within 30 s; every remount here is a new event.
const fresh = () => { _resetClientErrorThrottle(); rows.length = 0; };

test("remount record names its cause — the source changed", async () => {
  dom.window.localStorage.setItem(PLAYER_MODE_KEY, "attached");
  await show({ src: "youtube", tab: "live", active: "yt" });
  await show(null);
  fresh();
  await show({ src: "native", tab: "live", active: "sp" });
  assert.match(lastRemount(), /^player debug: remount \(cause=src:youtube→native,active:yt→sp #2 mode=attached\)/, `rows: ${rows.join(" | ")}`);
});

test("remount record names its cause — folded away and back (the stored mode)", async () => {
  // The fold writes the mode first; the player unmounts after the collapse.
  dom.window.localStorage.setItem(PLAYER_MODE_KEY, "none");
  await show(null);
  fresh();
  dom.window.localStorage.setItem(PLAYER_MODE_KEY, "attached");
  await show({ src: "native", tab: "live", active: "sp" });
  assert.match(lastRemount(), /^player debug: remount \(cause=mode:none→attached /, `rows: ${rows.join(" | ")}`);
});

test("restart: a remount with nothing it is keyed on changed says so — the page around it remounted", async () => {
  await show(null);
  fresh();
  await show({ src: "native", tab: "live", active: "sp" });
  assert.match(lastRemount(), /^player debug: remount \(cause=nothing-changed /, `rows: ${rows.join(" | ")}`);
  await show(null);
});
