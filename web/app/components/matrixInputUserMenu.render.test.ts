// #255 (k, 2026-11-06): "a redundant pfp settings button when the matrix panel is open in any
// expanded view". Wherever the Community view is wide enough to dock the rail beside the timeline
// (modes 2 and 3: /community, and the side panel at ≥ 680 px), the rail's own profile tile and the
// composer's profile button were both on screen and opened the same card. The rail's tile stays;
// the composer draws no button there. Its UserMenu stays MOUNTED (headless): it is the hub that
// answers every bb:open-* event (store, support, settings, mod panel) and hosts the card the
// rail's tile opens — unmounting it would turn those into dead clicks on /community.
// On a phone (mode 1) the rail and the timeline are never on screen together, so the composer
// keeps its button there.
//
// The real MatrixInput on a stub client, swapped in for useMatrixClient() the way
// matrixInputReturnKey.render.test.ts does it.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/matrixInputUserMenu.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage, serveJson } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";
import { stripComments } from "../lib/testSource.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM =
  "data:text/javascript," +
  encodeURIComponent(
    `export * from ${JSON.stringify(REAL_CTX)};\n` +
      "export function useMatrixClient() { return globalThis.__userMenuTestCtx; }\n" +
      "export function useMatrixIdentity() { return { matrixId: '@me:site.test', identityKnown: true }; }\n",
  );
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) {
      return { url: SHIM, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

installResizeObserverStub();
// The mod window the hub opens below reads a media query; jsdom has none. A desktop answer.
(dom.window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
});

const { MatrixInput } = await import("./MatrixInput.tsx");
const { dispatchClaimable } = await import("../lib/claimableEvent.ts");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const ROOM = { roomId: "!general:site.test", currentState: { getStateEvents: () => [] } };
(globalThis as unknown as { __userMenuTestCtx: unknown }).__userMenuTestCtx = {
  client: { getUserId: () => "@me:site.test", getDeviceId: () => null, getCrypto: () => undefined, getMediaConfig: async () => ({}), on: noop, off: noop, removeListener: noop },
  status: "ready", startClient: async () => {}, retry: noop,
  pendingVerification: null, clearPendingVerification: noop, matrixId: "@me:site.test", identityKnown: true,
};

/** The composer's profile button: UserMenu's own `title="<name> — profile"`. */
const profileButtons = (host: HTMLElement) => [...host.querySelectorAll("button")].filter((b) => / — profile$/.test(b.title));

function mount(props: { railBeside?: boolean; hideUserMenu?: boolean }) {
  resetStorage();
  serveJson({});
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const el = (p: typeof props) => React.createElement(MatrixInput as never, { value: "", onChange: noop, onSubmit: noop, room: ROOM, isSignedIn: true, ...p });
  act(() => root.render(el(props)));
  return {
    host,
    rerender(p: typeof props) { act(() => root.render(el(p))); },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
}

test("phone (no rail beside): the composer keeps its one profile button", () => {
  const m = mount({});
  assert.equal(profileButtons(m.host).length, 1);
  m.unmount();
});

test("rail beside the timeline: the composer draws NO profile button", () => {
  const m = mount({ railBeside: true });
  assert.equal(profileButtons(m.host).length, 0, "the rail's tile is the one button");
  m.unmount();
});

test("rail beside: the hub stays mounted, so the rail's tile (and every bb:open-* sender) is still answered", () => {
  const m = mount({ railBeside: true });
  // The rail tile sends exactly this (MatrixView openProfileCard). Unclaimed on /community it would
  // fall to the view's own card, and every store/support/settings opener would be a dead click.
  // The claim is synchronous; the card it then opens is not under test, so the root unmounts
  // before React renders it (outside act on purpose — act would flush the whole account card).
  const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prior = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = false;
  const claimed = dispatchClaimable("bb:open-profile-card");
  g.IS_REACT_ACT_ENVIRONMENT = prior;
  m.unmount();
  assert.equal(claimed, true, "a mounted hub claims the open");
  assert.equal(dispatchClaimable("bb:open-profile-card"), false, "control: with the composer gone nothing claims it");
});

test("split view (hideUserMenu) still removes the whole UserMenu — the live pane hosts it", () => {
  const m = mount({ hideUserMenu: true, railBeside: true });
  assert.equal(profileButtons(m.host).length, 0);
  m.unmount();
  assert.equal(dispatchClaimable("bb:open-profile-card"), false);
});

test("restart: a fresh mount in a wide view still draws no duplicate", () => {
  const a = mount({ railBeside: true });
  a.unmount();
  const b = mount({ railBeside: true });
  assert.equal(profileButtons(b.host).length, 0);
  b.unmount();
});

test("retry: narrowing to a phone and widening again flips the button each time, live", () => {
  const m = mount({ railBeside: true });
  m.rerender({ railBeside: false });
  assert.equal(profileButtons(m.host).length, 1, "narrow: the button is back");
  m.rerender({ railBeside: true });
  assert.equal(profileButtons(m.host).length, 0, "wide again: gone again");
  m.unmount();
});

test("wiring: every composer that can sit beside the docked rail is told so; the rail docks exactly off mode 1", () => {
  const read = (...p: string[]) => {
    const raw = readFileSync(path.join(WEB, "app", ...p), "utf8");
    return { raw, src: stripComments(raw) };
  };
  const timeline = read("features", "community", "Timeline.tsx");
  assert.match(timeline.src, /<MatrixInput[\s\S]{0,700}railBeside=\{!compact\}/, "the channel composer");
  const thread = read("features", "community", "ThreadPanel.tsx");
  assert.match(thread.src, /<MatrixInput[\s\S]{0,700}railBeside=\{!compact\}/, "a forum post's reply box (it shows a UserMenu)");
  // Read-only: MatrixView passes compact = mode 1, and off mode 1 the rail is always docked.
  const view = read("features", "community", "MatrixView.tsx");
  assert.match(view.src, /const compact = mode === 1;/);
  assert.match(view.src, /compact=\{compact\}/);
  assert.match(view.src, /compact=\{mode === 1\}/, "the thread panel's compact");
  const input = read("components", "MatrixInput.tsx");
  assert.match(input.src, /<UserMenu button=\{!railBeside\} \/>/);
  // End anchors: every file above was read to its last line.
  assert.match(timeline.raw.trimEnd().slice(-60), /\}\s*$/);
  assert.match(view.raw, /return <UnifiedLayout pageChrome \/>;\s*\}\s*$/);
  assert.match(input.raw.trimEnd().slice(-200), /\}\s*$/);
});
