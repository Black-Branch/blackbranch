// The first-run prompts, RENDERED: one at a time (the shared slot), sitting on the bottom bar's
// live height so a growing composer pushes them up instead of being covered; and the old
// first-open Matrix-apps banner gone with its event.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/nudgeStack.render.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dom, React, act, fakePhoneViewport } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";
import { stripComments } from "../lib/testSource.ts";

// The two heavy hooks are swapped for switchable stand-ins: useMatrixSettings drags in the
// matrix-js-sdk crypto stack, usePwaInstall waits on a browser event jsdom never sends.
// Registered after testTsx's hooks, so these run first and hand everything else on.
type Stand = { flowState: string; pwa: { canInstall: boolean; isIos: boolean; isStandalone: boolean }; settingsOpts: unknown };
const stand = globalThis as unknown as { __nudgeStand: Stand };
stand.__nudgeStand = { flowState: "setup", pwa: { canInstall: true, isIos: false, isStandalone: false }, settingsOpts: null };
const STUBS: Record<string, string> = {
  "@/app/lib/useMatrixSettings":
    "export function useMatrixSettings(o){ globalThis.__nudgeStand.settingsOpts = o; return { flowState: globalThis.__nudgeStand.flowState }; }",
  "@/app/lib/usePwaInstall":
    "export function usePwaInstall(){ return { ...globalThis.__nudgeStand.pwa, promptInstall: () => {} }; }",
};
(nodeModule as unknown as {
  registerHooks: (h: { resolve: (s: string, c: unknown, n: (s: string, c: unknown) => unknown) => unknown }) => void;
}).registerHooks({
  resolve(specifier, context, next) {
    const body = STUBS[specifier];
    if (body) return { url: `data:text/javascript,${encodeURIComponent(body)}`, format: "module", shortCircuit: true };
    return next(specifier, context);
  },
});

const ro = installResizeObserverStub();
fakePhoneViewport();
const { default: SecureAccountPromptInner } = await import("./SecureAccountPromptInner.tsx");
const { default: PwaInstallNudge } = await import("./PwaInstallNudge.tsx");
const { Bar } = await import("./chrome/index.ts");
const { useNudgeSlot, _resetNudgeSlotForTests } = await import("../lib/nudgeSlot.ts");
const { createRoot } = await import("react-dom/client");

const WEB_APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = dom.window.document;

/** The help-desk greeting lives inside the whole chat sidebar; this probe claims its slot the same way. */
function HelpDeskProbe() {
  const holds = useNudgeSlot("help-desk", true);
  return holds ? React.createElement("p", null, "Help desk greeting") : null;
}

function mount(children: () => React.ReactNode) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  const render = () => act(async () => { root.render(React.createElement(React.Fragment, null, children())); });
  return {
    host,
    render,
    text: () => host.textContent ?? "",
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const PROMPTS = { secure: "Secure your account", pwa: "Install", help: "Help desk greeting" } as const;
const visible = (text: string) => (Object.keys(PROMPTS) as (keyof typeof PROMPTS)[]).filter((k) => text.includes(PROMPTS[k]));

beforeEach(() => {
  _resetNudgeSlotForTests();
  stand.__nudgeStand.flowState = "setup";
  stand.__nudgeStand.pwa = { canInstall: true, isIos: false, isStandalone: false };
});

test("all three wanting → exactly one visible, and its dismissal shows no other this load", async () => {
  let secureMounted = true;
  const m = mount(() => [
    React.createElement(PwaInstallNudge, { key: "pwa" }),
    secureMounted && React.createElement(SecureAccountPromptInner, { key: "secure", onDismiss: () => { secureMounted = false; } }),
    React.createElement(HelpDeskProbe, { key: "help" }),
  ]);
  await m.render();
  assert.deepEqual(visible(m.text()), ["secure"], m.text());
  // The real crypto rule stays: this mount only reads flowState.
  assert.deepEqual(stand.__nudgeStand.settingsOpts, { consumeVerification: false });

  const later = [...m.host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Later");
  assert.ok(later, "no Later button");
  await act(async () => { later.click(); });
  await m.render(); // the outer SecureAccountPrompt unmounts Inner on dismiss
  assert.deepEqual(visible(m.text()), [], `after the dismissal: ${m.text()}`);
  await m.unmount();
});

test("with nothing to secure, the install prompt takes the slot", async () => {
  stand.__nudgeStand.flowState = "ready";
  const m = mount(() => [
    React.createElement(PwaInstallNudge, { key: "pwa" }),
    React.createElement(SecureAccountPromptInner, { key: "secure", onDismiss: () => {} }),
    React.createElement(HelpDeskProbe, { key: "help" }),
  ]);
  await m.render();
  assert.deepEqual(visible(m.text()), ["pwa"], m.text());
  await m.unmount();
});

test("each prompt's bottom style uses --chrome-bottom-live", async () => {
  for (const [name, el] of [
    ["SecureAccountPromptInner", React.createElement(SecureAccountPromptInner, { onDismiss: () => {} })],
    ["PwaInstallNudge", React.createElement(PwaInstallNudge)],
  ] as const) {
    _resetNudgeSlotForTests();
    const m = mount(() => el);
    await m.render();
    const outer = m.host.firstElementChild as HTMLElement | null;
    assert.ok(outer, `${name} rendered nothing`);
    assert.match(outer.className, /\bfixed\b/, `${name}: the outer box is the fixed one`);
    assert.doesNotMatch(outer.className, /\bbottom-0\b/, `${name}: still pinned to the screen's bottom edge`);
    const style = outer.getAttribute("style") ?? "";
    assert.match(style, /bottom:[^;]*var\(--chrome-bottom-live,\s*var\(--chrome-bottom-h\)\)/,
      `${name}: bottom does not ride on the bar's live height`);
    // The bar sits above the panel's gap and frame; without them the card covered the composer's
    // top 2 px at 390 (look 06, card bottom 670 vs composer top 668).
    assert.match(style, /bottom:\s*calc\([^;]*\+\s*var\(--panel-gap,\s*12px\)\s*\+\s*var\(--frame-width,\s*2px\)\)/,
      `${name}: bottom leaves out the panel gap and frame under the bar`);
    await m.unmount();
  }
});

test("Bar writes --chrome-bottom-live from a stubbed ResizeObserver", async () => {
  const html = doc.documentElement;
  html.style.removeProperty("--chrome-bottom-live");
  let h = 48;
  const m = mount(() => React.createElement(Bar, { slot: "bottom", center: "composer" }));
  await m.render();
  const bar = m.host.querySelector(".chrome-bar-bottom") as HTMLElement | null;
  assert.ok(bar, "no bottom bar");
  assert.ok(ro.observed.includes(bar), "the bottom bar is not observed");
  bar.getBoundingClientRect = () => ({ height: h, width: 390, top: 0, left: 0, right: 390, bottom: h, x: 0, y: 0, toJSON() {} }) as DOMRect;

  await act(async () => { ro.fire(); });
  assert.equal(html.style.getPropertyValue("--chrome-bottom-live"), "48px");
  h = 112; // the composer grew to three lines
  await act(async () => { ro.fire(); });
  assert.equal(html.style.getPropertyValue("--chrome-bottom-live"), "112px");

  await m.unmount();
  assert.equal(html.style.getPropertyValue("--chrome-bottom-live"), "", "a bar that left still holds the value");
});

test("a top bar writes nothing", async () => {
  const html = doc.documentElement;
  html.style.removeProperty("--chrome-bottom-live");
  const m = mount(() => React.createElement(Bar, { slot: "top", center: "title" }));
  await m.render();
  const bar = m.host.querySelector(".chrome-bar-top") as HTMLElement;
  bar.getBoundingClientRect = () => ({ height: 50 }) as DOMRect;
  await act(async () => { ro.fire(); });
  assert.equal(html.style.getPropertyValue("--chrome-bottom-live"), "");
  await m.unmount();
});

test("the help-desk greeting opens only while it holds the slot", () => {
  const src = stripComments(readFileSync(path.join(WEB_APP, "features", "chat", "ChatSidebar.tsx"), "utf8"));
  assert.match(src, /<\/aside>\s*\);\s*\}\s*$/, "END of ChatSidebar.tsx not read");
  assert.match(src, /const greetHolds = useNudgeSlot\("help-desk", greeting !== null\);/);
  // The answer from /api/nudges only records what to say; it opens nothing itself.
  const fetchAt = src.indexOf('getJson<{ link_account?: { show: boolean; offerNever: boolean } }>("/api/nudges")');
  assert.ok(fetchAt > 0, "the load-time nudge fetch moved");
  const fetchBody = src.slice(fetchAt, src.indexOf("}, [isPopout, isSignedIn]);", fetchAt));
  assert.ok(fetchBody.length > 100, "the fetch effect's end moved");
  assert.doesNotMatch(fetchBody, /convoOpen|setSupportActive|lsSet/, "the fetch opens the greeting itself");
  // The opening effect returns early unless the slot is held, then greets.
  const gate = src.indexOf("if (!greetHolds || !greeting || greeted.current) return;");
  assert.ok(gate > fetchAt, "no slot gate after the fetch");
  const first = src.indexOf("convoOpen(FIRST_VISIT)", gate);
  const link = src.indexOf("convoOpen(LINK_NUDGE_LINE", gate);
  assert.ok(first > gate && link > gate && first - gate < 800 && link - gate < 800, "the greeting does not open behind the gate");
  // Closing the help desk is the greeting's dismissal: it lets the slot go.
  assert.match(src, /const closeSupport = useCallback\(\(\) => \{[\s\S]{0,200}setGreeting\(null\);/);
});

test("the main layout mounts no MatrixAppsHint and the file is gone", () => {
  const src = stripComments(readFileSync(path.join(WEB_APP, "(main)", "layout.tsx"), "utf8"));
  // End anchor: the layout's last lines were read, so the absence below means something.
  assert.match(src, /<\/MatrixClientProvider>\s*\);\s*\}\s*$/, "END of (main)/layout.tsx not read");
  assert.match(src, /<PwaInstallNudge \/>/, "the layout's nudges were not read");
  assert.doesNotMatch(src, /MatrixAppsHint/);
  assert.equal(existsSync(path.join(WEB_APP, "components", "MatrixAppsHint.tsx")), false);
  assert.equal(existsSync(path.join(WEB_APP, "components", "MatrixAppsList.tsx")), false);
});

test("no listener and no dispatcher of bb:matrix-opened remain", () => {
  const EVENT = ["bb", "matrix-opened"].join(":");
  const self = fileURLToPath(import.meta.url); // its title names the event
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(name) && p !== self) files.push(p);
    }
  };
  walk(WEB_APP);
  // Guard the scan, not the result: it read the tree, including the sidebar that dispatched it.
  assert.ok(files.length > 500, `only ${files.length} files under app/ — the walk read nothing`);
  const sidebar = stripComments(readFileSync(path.join(WEB_APP, "features", "chat", "ChatSidebar.tsx"), "utf8"));
  assert.match(sidebar, /<\/aside>\s*\);\s*\}\s*$/, "END of ChatSidebar.tsx not read");
  const hits = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes(EVENT));
  assert.deepEqual(hits.map((f) => path.relative(WEB_APP, f)), []);
});
