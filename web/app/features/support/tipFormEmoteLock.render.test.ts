// TipForm's lock must also freeze the emote suggestion path. A SEPARATE file
// from TipPayButton.render.test.ts and PayPalButton.render.test.ts on purpose:
// useEmotes() caches its /api/emotes fetch for the whole PROCESS
// (module-level `freshFetch`/`cachedManifest`, useEmotes.ts), and every
// other TipForm-mounting test in this feature serves an EMPTY manifest —
// sharing a process with them would mean this file's real manifest never
// actually gets fetched. `node --test` runs each FILE in its own process,
// so a separate file is a clean cache boundary (same reasoning
// emoteReadiness.render.test.ts documents for the same hook).
//
// The scenario: type "go :Kek" (the list
// opens) -> click the PayPal button without picking an emote -> the snapshot
// carries "go :Kek" and the form locks -> click "KEKW" in the STILL-OPEN
// list -> the screen would show "go KEKW" while the order carries "go :Kek".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { _resetPaypalSdkForTests } = await import("./PayPalButton.tsx");

type ButtonsConfig = {
  fundingSource: string;
  onClick: (data: unknown, actions: { reject?: () => unknown } | undefined) => unknown;
  createOrder: () => Promise<string>;
  onApprove: (data: { orderID: string }) => Promise<void>;
  onError: (err: unknown) => void;
  onCancel: () => void;
};

const EMOTE_MANIFEST = { Kek: { url: "https://cdn.example/kek.webp", zeroWidth: false } };

function harness() {
  const configs: ButtonsConfig[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/emotes")) return Promise.resolve(new Response(JSON.stringify(EMOTE_MANIFEST), { status: 200 }));
    if (u.includes("/api/billing/paypal/order")) return Promise.resolve(new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
    if (u.includes("/api/billing/paypal/capture")) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return {
    configs,
    installPaypalGlobal() {
      (window as unknown as { paypal: unknown }).paypal = {
        FUNDING: { PAYPAL: "paypal", VENMO: "venmo" },
        Buttons: (config: ButtonsConfig) => ({
          render: () => { configs.push(config); },
          close: () => {},
          isEligible: () => true,
        }),
      };
    },
  };
}

// jsdom has no scrollIntoView — EmoteCompletionList's highlighted-option
// effect calls it unconditionally on mount/selection-change.
if (!dom.window.Element.prototype.scrollIntoView) {
  dom.window.Element.prototype.scrollIntoView = () => {};
}

const { TipForm } = await import("./TipForm.tsx");
const { createRoot } = await import("react-dom/client");

function mount(props: Partial<Parameters<typeof TipForm>[0]> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const defaults: Parameters<typeof TipForm>[0] = { busy: false, signedIn: true, initialName: "", onSubmit: () => {} };
  act(() => root.render(React.createElement(TipForm, { ...defaults, ...props })));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

function scriptTag(): HTMLScriptElement | null {
  return dom.window.document.querySelector('script[src*="paypal.com/sdk/js"]');
}

// One `.value =` jump (rather than per-character) leaves useEmoteAutocomplete's
// `caret` state ONE RENDER behind (its own header comment: "a one-frame lag is
// harmless… by which point this has corrected") — the debounce effect that ARMS
// the show-timer only gets ONE chance, right after `value` changes, and on that
// first render the stale caret can make `rawOverlayMatches` read as empty, so
// the timer never arms at all. Real typing never hits this: each keystroke is
// its own value change, so the effect gets another chance on the very next one.
// Typing character-by-character here is what makes this harness behave like a
// real browser rather than a paste.
function typeIncrementally(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  for (let i = 1; i <= text.length; i++) {
    act(() => {
      setter.call(textarea, text.slice(0, i));
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
}

test("while locked, an already-open emote suggestion list is hidden, and the message no longer changes", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: "cid" });
  // A macrotask flush, not a bare microtask — useEmotes()' fetch chains
  // several promise hops (fetch -> .then(json) -> cache -> notify), and a
  // single microtask tick can land between them.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const textarea = m.host.querySelector("textarea") as HTMLTextAreaElement;
  typeIncrementally(textarea, "nice :Kek");
  // A colon trigger debounces 100ms before the overlay shows (useEmoteAutocomplete.ts).
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

  assert.ok(
    m.host.querySelector("#support-emote-listbox"),
    "vacuity anchor: the emote suggestion list never opened — nothing below would prove anything",
  );
  const messageBeforeLock = textarea.value;

  const script = scriptTag();
  assert.ok(script, "vacuity anchor: SDK script never injected");
  await act(async () => {
    h.installPaypalGlobal();
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.equal(h.configs.length, 1, "vacuity anchor: the PayPal button never rendered");
  act(() => { h.configs[0]!.onClick(undefined, {}); }); // snapshots + locks, WITHOUT picking an emote

  assert.ok(!m.host.querySelector("#support-emote-listbox"), "the emote suggestion list must be hidden once locked");
  // The combobox ARIA must follow the list, not the raw matches — else the
  // textarea names a listbox that is no longer in the DOM.
  assert.equal(textarea.getAttribute("aria-expanded"), "false", "aria-expanded must go false with the list hidden");
  assert.equal(textarea.getAttribute("aria-controls"), null, "aria-controls must not point at the hidden listbox");
  assert.equal(textarea.getAttribute("aria-activedescendant"), null, "aria-activedescendant must not point into the hidden listbox");
  assert.equal(textarea.value, messageBeforeLock, "the message must not have changed just from locking");

  m.unmount();
});

// Behavioural coverage above proves the list disappears — that alone makes
// its onMouseDown unreachable through the DOM. The `setValue` no-op is the
// coordinator's explicit belt-and-suspenders SECOND mechanism (same shape as
// PayPalButton's `!valid` guard existing independently of the CSS greying),
// for a click that was already in flight before the list unmounts — not
// reachable through a jsdom dispatchEvent on an already-removed node, so
// pinned structurally here rather than left silently unverified.
test("the setValue passed to useEmoteAutocomplete is guarded by controlsDisabled — the second, independent mechanism", () => {
  const src = readFileSync(new URL("./TipForm.tsx", import.meta.url), "utf8");
  assert.ok(src.trimEnd().endsWith("}"), "vacuity anchor: TipForm.tsx truncated");
  assert.ok(
    /setValue:\s*\(v\)\s*=>\s*\{\s*if\s*\(!controlsDisabled\)\s*setMessage\(v\);\s*\}/.test(src),
    "useEmoteAutocomplete's setValue must be a no-op while locked, independent of the list being hidden",
  );
});

test("while a PayPal order is open, the Announce switch is disabled", async () => {
  // Reset the module-shared PayPal SDK state before this second PayPal-
  // touching test in the file — otherwise this mount reads the FIRST test's
  // already-"ready" status and already-installed `window.paypal` the instant
  // it mounts, and renders into that earlier test's own `configs` array
  // instead of this test's `h.configs`, which then never sees the render
  // (same isolation shape TipPayButton.points.render.test.ts's beforeEach
  // exists for).
  delete (window as unknown as { paypal?: unknown }).paypal;
  scriptTag()?.remove();
  _resetPaypalSdkForTests();
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: "cid" });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const script = scriptTag();
  assert.ok(script, "vacuity anchor: SDK script never injected");
  await act(async () => {
    h.installPaypalGlobal();
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.ok(h.configs.length >= 1, "vacuity anchor: the PayPal button never rendered");
  const sw = m.host.querySelector('button[role="switch"][aria-label="Announce on stream"]') as HTMLButtonElement;
  assert.ok(sw && !sw.disabled, "vacuity anchor: switch missing or already disabled before the lock");
  act(() => { h.configs.at(-1)!.onClick(undefined, {}); });
  assert.equal(sw.disabled, true, "flipping the switch mid-order would change what the open order is for");
  m.unmount();
});
