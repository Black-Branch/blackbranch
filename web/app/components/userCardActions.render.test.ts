// The live-chat user card's own actions (client polish Task 9, ticket #191: "hide and report button
// too close to the x, and 'hide' seems like a synonym to the x").
//
// The card sits in a Window whose band holds the ✕ at the top right; the banner's top-right corner
// is directly under it. Hide and Report lived in that corner, the rightmost one next to the ✕, and
// "Hide" read like another close. They now sit in the card's action row under the name, and Hide
// says what it does: "Hide messages". Message (and Gift) stay on the banner. The distance from the
// ✕ in pixels is the Look's (look/09-card.mjs at 390 px); this mounts the REAL card and asserts
// where each button is in the card's structure.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/userCardActions.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";

// The card reads the signed-in Matrix id through useMatrixIdentity(); that one hook is swapped for
// a fixed identity by resolving the context module to a shim that re-exports the real one.
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM = "data:text/javascript," + encodeURIComponent(
  `export * from ${JSON.stringify(REAL_CTX)};\nexport function useMatrixIdentity() { return { matrixId: "@me:site.test", identityKnown: true }; }\n`,
);
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) return { url: SHIM, shortCircuit: true };
    return next(specifier, context);
  },
});
// StyledName fits the name with getComputedStyle, a browser global testDom does not install.
(globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} };
// The card's lookups never answer here: this test is about where the buttons are.
(globalThis as unknown as { fetch: () => Promise<never> }).fetch = () => new Promise<never>(() => {});

const { default: UserCard } = await import("./UserCard.tsx");
const { createRoot } = await import("react-dom/client");

const msg = {
  id: 42, platform: "native", username: "casey", message: "hello", isMod: false, isVip: false, isMember: false,
  ts: Date.UTC(2026, 9, 31, 12, 0, 0), matrixId: "@casey:site.test", publicId: null,
};

async function mount(props: Record<string, unknown> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(UserCard as never, { msg, isMod: false, onClose: () => {}, onStartDM: () => {}, inPanel: true, ...props }));
  });
  return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

const byText = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;

test("Hide reads 'Hide messages' and is not in the close row", async () => {
  const { host, unmount } = await mount();
  const hide = byText(host, "Hide messages");
  const report = byText(host, "Report");
  const message = byText(host, "Message");
  assert.ok(hide, "a Hide messages button");
  assert.ok(report, "a Report button");
  assert.ok(message, "Message is still offered");
  assert.equal(byText(host, "Hide"), null, "no bare 'Hide' that reads like the ✕");

  // The banner (its first block) carries the top-right corner under the window's ✕.
  const banner = host.firstElementChild?.firstElementChild as HTMLElement | null;
  assert.ok(banner && banner.contains(message), "Message stays on the banner");
  assert.equal(banner.contains(hide), false, "Hide is not in the banner's top-right corner");
  assert.equal(banner.contains(report), false, "Report is not in the banner's top-right corner");

  // Both live in the card's action row, which comes after the name.
  const row = host.querySelector("[data-card-actions]");
  assert.ok(row, "the card has an action row");
  assert.ok(row.contains(hide) && row.contains(report), "Hide and Report are in the action row");
  const name = [...host.querySelectorAll("span")].find((s) => s.textContent === "casey");
  assert.ok(name, "the name renders");
  assert.ok(name.compareDocumentPosition(row) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "the row is under the name");
  await unmount();
});

test("your own card has no Hide, Report or action row", async () => {
  const { host, unmount } = await mount({ msg: { ...msg, matrixId: "@me:site.test" } });
  assert.equal(byText(host, "Hide messages"), null);
  assert.equal(byText(host, "Report"), null);
  assert.equal(host.querySelector("[data-card-actions]"), null);
  await unmount();
});
