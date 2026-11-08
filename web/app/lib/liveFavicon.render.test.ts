// Ticket #190: the tab icon carries a small red dot while the stream is live.
//
// What it must do: live = the page's own tab icon swapped for a dotted copy drawn from it; the
// stream ending = the exact original address back; nothing known yet (a fresh page, a report
// that knows nothing) = the icon untouched, so a reload never flashes a dot. The live state is the
// platformStates frame on the page's one socket: no request of its own.
//
// Driven, not scanned: a fake WebSocket runs the real shared socket and the real hook.
//
// Run: node --test app/lib/liveFavicon.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dom, React, act } from "./testDom.ts";

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  url: string;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
  frame(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
  drop() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
  close() { this.readyState = FakeWS.CLOSED; }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
(globalThis as unknown as { MutationObserver: unknown }).MutationObserver ??= dom.window.MutationObserver;

const { useLiveFavicon } = await import("./useLiveFavicon.ts");
const { paintLiveDot, dotGeometry, liveStateOf } = await import("./liveFavicon.ts");
const { createRoot } = await import("react-dom/client");

const doc = dom.window.document;
const PLAIN = "/brand/icon.png";
const latest = () => FakeWS.all[FakeWS.all.length - 1]!;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function frame(states: Record<string, string>, at = Date.now()) {
  const platforms = Object.fromEntries(Object.entries(states).map(([p, state]) => [p, { state, since: at }]));
  return { type: "platformStates", at, platforms };
}

/** A head as the layout renders it, and the hook mounted. `dotted` stands in for the canvas. */
async function mount(dotted: (href: string) => Promise<string | null> = async (h) => `data:dotted,${h}`) {
  doc.head.innerHTML = `<link rel="icon" href="${PLAIN}" type="image/png" sizes="512x512"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">`;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  function Probe() { useLiveFavicon(dotted); return null; }
  await act(async () => { root.render(React.createElement(Probe)); });
  const ws = latest();
  await act(async () => { ws.open(); });
  return {
    ws,
    icon: () => doc.querySelector('link[rel="icon"]')!.getAttribute("href"),
    apple: () => doc.querySelector('link[rel="apple-touch-icon"]')!.getAttribute("href"),
    send: async (f: object, sock = ws) => { await act(async () => { sock.frame(f); }); await flush(); },
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

// ── The dot itself ─────────────────────────────────────────────────────────────

test("the dot: red pixels in the bottom-right corner of a 32 px icon, and none anywhere else", () => {
  const size = 32;
  const px = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 40; px[i + 1] = 90; px[i + 2] = 200; px[i + 3] = 255; }
  const before = px.slice();
  paintLiveDot(px, size);
  const { cx, cy, r, ring } = dotGeometry(size);
  const isRed = (i: number) => px[i]! > 200 && px[i + 1]! < 60 && px[i + 2]! < 60;
  let red = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (isRed(i)) {
        red++;
        assert.ok(x >= size / 2 && y >= size / 2, `a red pixel at ${x},${y}, outside the bottom-right corner`);
      }
      if (d > r + ring + 1) {
        for (let c = 0; c < 4; c++) assert.equal(px[i + c], before[i + c], `pixel ${x},${y} changed outside the dot`);
      }
    }
  }
  assert.ok(red >= 12, `only ${red} red pixels: the dot is missing or tiny`);
  const centre = (Math.floor(cy) * size + Math.floor(cx)) * 4;
  assert.ok(isRed(centre), "the dot's centre is not red");
  // The ring: just outside the red, the pixel is dark, so the dot reads on a light or red icon.
  const ringAt = (Math.floor(cy) * size + Math.min(size - 1, Math.floor(cx + r + ring * 0.5))) * 4;
  assert.ok(px[ringAt]! < 80 && px[ringAt + 1]! < 80 && px[ringAt + 2]! < 80, "no dark ring around the dot");
  // About 28 % of the icon wide, in the corner.
  assert.ok(Math.abs((2 * r) / size - 0.28) < 0.02);
  assert.ok(cx + r + ring <= size && cy + r + ring <= size, "the dot runs off the icon");
});

test("the dot on a see-through icon: solid in the middle, soft at its edge, nothing painted outside it", () => {
  const size = 32;
  const px = new Uint8ClampedArray(size * size * 4);
  paintLiveDot(px, size);
  const { cx, cy, r, ring } = dotGeometry(size);
  const alpha = (x: number, y: number) => px[(y * size + x) * 4 + 3]!;
  assert.equal(alpha(Math.floor(cx), Math.floor(cy)), 255);
  let soft = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = alpha(x, y);
    if (a > 0 && a < 255) soft++;
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r + ring + 1) assert.equal(a, 0, `painted outside the dot at ${x},${y}`);
  }
  assert.ok(soft > 0, "the dot has a hard staircase edge");
});

test("live, offline and unknown from a platformStates report", () => {
  const at = 1;
  const snap = (p: Record<string, string>) => ({ at, platforms: Object.fromEntries(Object.entries(p).map(([k, state]) => [k, { state, since: at }])) }) as Parameters<typeof liveStateOf>[0];
  assert.equal(liveStateOf(snap({ twitch: "offline", kick: "live" })), "live");
  assert.equal(liveStateOf(snap({ twitch: "offline", youtube: "upcoming" })), "offline");
  assert.equal(liveStateOf(snap({ twitch: "offline", kick: "unknown" })), "unknown", "a platform not read is not 'ended'");
  assert.equal(liveStateOf(snap({})), "unknown", "an empty report (stream-api just started) is not 'offline'");
});

// ── The page ───────────────────────────────────────────────────────────────────

test("live = the tab icon becomes the dotted copy of ITS OWN address; the home-screen icon is left alone", async (t) => {
  const p = await mount();
  t.after(p.unmount);
  await p.send(frame({ twitch: "live", youtube: "offline" }));
  assert.equal(p.icon(), `data:dotted,${PLAIN}`);
  assert.equal(p.apple(), "/brand/apple-touch-icon.png");
});

test("a navigation that renders the icon link afresh gets the dot again while live", async (t) => {
  const p = await mount();
  t.after(p.unmount);
  await p.send(frame({ twitch: "live" }));
  const fresh = doc.createElement("link");
  fresh.rel = "icon";
  fresh.setAttribute("href", PLAIN);
  await act(async () => { doc.querySelector('link[rel="icon"]')!.replaceWith(fresh); });
  await flush();
  assert.equal(p.icon(), `data:dotted,${PLAIN}`, "the re-rendered icon lost the dot");
  await p.send(frame({ twitch: "offline" }));
  assert.equal(p.icon(), PLAIN);
});

test("offline = the original address back, exactly", async (t) => {
  const p = await mount();
  t.after(p.unmount);
  await p.send(frame({ twitch: "live" }));
  await p.send(frame({ twitch: "offline" }));
  assert.equal(p.icon(), PLAIN);
  assert.equal(doc.querySelector('link[rel="icon"]')!.hasAttribute("data-plain-href"), false);
});

test("unknown = untouched: no report yet, and a report that knows nothing, change nothing", async (t) => {
  const p = await mount();
  t.after(p.unmount);
  assert.equal(p.icon(), PLAIN, "a fresh page changed its icon before any report");
  await p.send(frame({}));
  assert.equal(p.icon(), PLAIN);
  await p.send(frame({ twitch: "live" }));
  await p.send(frame({ twitch: "unknown" }));
  assert.equal(p.icon(), `data:dotted,${PLAIN}`, "the reports going silent took the dot off a live stream");
});

test("restart: a dropped socket reconnects, its connect report puts the right icon up again", async (t) => {
  const p = await mount();
  t.after(p.unmount);
  await p.send(frame({ twitch: "live" }));
  await act(async () => { p.ws.drop(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 1_100)); });
  const again = latest();
  assert.notEqual(again, p.ws, "no reconnect");
  await act(async () => { again.open(); });
  // The stream ended while the socket was down: the reconnect's report says so.
  await p.send(frame({ twitch: "offline" }), again);
  assert.equal(p.icon(), PLAIN);
  await p.send(frame({ twitch: "live" }), again);
  assert.equal(p.icon(), `data:dotted,${PLAIN}`);
});

test("restart: a reloaded page starts from the plain icon, never a stale dot", async () => {
  const first = await mount();
  await first.send(frame({ twitch: "live" }));
  await first.unmount();
  const p = await mount();
  try {
    assert.equal(p.icon(), PLAIN);
  } finally {
    await p.unmount();
  }
});

test("retry: a dot that could not be drawn is drawn on the next live report", async (t) => {
  let fail = true;
  const p = await mount(async (h) => (fail ? null : `data:dotted,${h}`));
  t.after(p.unmount);
  await p.send(frame({ twitch: "live" }));
  assert.equal(p.icon(), PLAIN, "a failed drawing must leave the plain icon");
  fail = false;
  await p.send(frame({ twitch: "live", kick: "offline" }));
  assert.equal(p.icon(), `data:dotted,${PLAIN}`, "the next live report did not try again");
});

test("retry: live, offline, live again, and a stream that ends while the dot is being drawn keeps no dot", async (t) => {
  let release: (() => void) | null = null;
  const p = await mount((h) => new Promise((r) => { release = () => r(`data:dotted,${h}`); }));
  t.after(p.unmount);
  await p.send(frame({ twitch: "live" }));
  await p.send(frame({ twitch: "offline" }));
  await act(async () => { release!(); });
  await flush();
  assert.equal(p.icon(), PLAIN, "the dot came back after the stream ended");
  await p.send(frame({ twitch: "live" }));
  await act(async () => { release!(); });
  await flush();
  assert.equal(p.icon(), `data:dotted,${PLAIN}`);
});

test("one place: the hook is mounted once, in the root layout, and asks for nothing by itself", () => {
  const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
  assert.equal(layout.match(/<LiveFavicon \/>/g)?.length, 1, "LiveFavicon is not mounted exactly once in the root layout");
  const appDir = fileURLToPath(new URL("..", import.meta.url));
  const callers = (readdirSync(appDir, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith("useLiveFavicon.ts"))
    .filter((f) => /\buseLiveFavicon\(/.test(readFileSync(join(appDir, f), "utf8")));
  assert.deepEqual(callers, [join("components", "LiveFavicon.tsx")], "useLiveFavicon is called from somewhere else too");
  const hook = readFileSync(new URL("./useLiveFavicon.ts", import.meta.url), "utf8");
  assert.doesNotMatch(hook, /fetch\(|getJson|setInterval/, "the live dot polls on its own");
  // Vacuity: the scan read the hook to its end.
  assert.match(hook.slice(-200), /return shown\.state;\s*\}\s*$/);
});
