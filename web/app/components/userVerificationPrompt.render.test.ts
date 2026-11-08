// The person-to-person verification prompt, RENDERED with the real hook (useMatrixVerification) on
// a fake request: what a person sees when someone verifies them, and that Settings' own-device
// requests are left alone. The real-device run is matrixCryptoRepairs.hs.test.ts.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/userVerificationPrompt.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dom, React, act } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";

installResizeObserverStub();
const { default: UserVerificationHost } = await import("./UserVerificationWindow.tsx");
const { _resetWindowLayerForTests } = await import("../lib/chrome/windowLayer.ts");
const { createRoot } = await import("react-dom/client");

const EMOJI: Array<[string, string]> = [["🐶", "Dog"], ["🐱", "Cat"], ["🦁", "Lion"], ["🐎", "Horse"], ["🦄", "Unicorn"], ["🐷", "Pig"], ["🐘", "Elephant"]];

/** A request as the SDK hands it over, reduced to what the hook touches. */
function fakeRequest(over: Partial<{ isSelfVerification: boolean; otherUserId: string; initiatedByMe: boolean }> = {}, opts: { doneOnConfirm?: boolean } = {}) {
  const calls: string[] = [];
  let done = () => {};
  const verifier = Object.assign(new EventEmitter(), {
    getShowSasCallbacks: () => null,
    verify: () => new Promise<void>((resolve) => { done = resolve; }),
  });
  const req = Object.assign(new EventEmitter(), {
    otherUserId: "@riley:site.test", isSelfVerification: false, initiatedByMe: false, phase: 2,
    verifier: undefined as unknown,
    accept: async () => { calls.push("accept"); req.phase = 3; req.emit("change"); },
    cancel: async () => { calls.push("cancel"); req.phase = 5; req.emit("change"); },
    startVerification: async () => {
      calls.push("start");
      setTimeout(() => verifier.emit("show_sas", { sas: { emoji: EMOJI }, confirm: async () => { calls.push("confirm"); if (opts.doneOnConfirm) done(); }, mismatch: async () => { calls.push("mismatch"); }, cancel: () => {} }), 0);
      return verifier;
    },
    ...over,
  });
  return { req, calls };
}

const client = { getUserId: () => "@casey:site.test", getUser: (id: string) => (id === "@riley:site.test" ? { displayName: "Riley" } : null) };

function mount(pending: unknown) {
  _resetWindowLayerForTests();
  let cleared = 0;
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(UserVerificationHost, {
    client: client as never, pendingVerification: pending, clearPendingVerification: () => { cleared += 1; },
  })));
  const text = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  return {
    text, button, get cleared() { return cleared; },
    click: async (label: string) => { const b = button(label); assert.ok(b, `no "${label}" in: ${text()}`); await act(async () => { b.click(); }); },
    settle: () => act(async () => { await new Promise((r) => setTimeout(r, 20)); }),
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };
}

test("incoming user request shows name + Accept/Decline", async () => {
  const { req } = fakeRequest();
  const m = mount(req);
  assert.match(m.text(), /Riley wants to verify you/);
  assert.ok(m.button("Accept"));
  assert.ok(m.button("Decline"));
  assert.equal(m.cleared, 1, "the prompt took the request");
  m.unmount();
});

test("Decline cancels the request", async () => {
  const { req, calls } = fakeRequest();
  const m = mount(req);
  await m.click("Decline");
  assert.deepEqual(calls, ["cancel"]);
  assert.match(m.text(), /Verification cancelled/);
  m.unmount();
});

test("SAS state shows 7 emoji and both buttons", async () => {
  const { req, calls } = fakeRequest();
  const m = mount(req);
  await m.click("Accept");
  await m.settle();
  for (const [e] of EMOJI) assert.ok(m.text().includes(e), `emoji ${e} missing`);
  assert.equal(EMOJI.length, 7);
  assert.ok(m.button("They match"));
  assert.ok(m.button("They don't match"));
  await m.click("They match");
  assert.deepEqual(calls, ["accept", "start", "confirm"]);
  assert.match(m.text(), /Waiting for Riley to confirm/);
  m.unmount();
});

test("the person's user id stands beside the name at every step (a display name is free text)", async () => {
  const { req } = fakeRequest({}, { doneOnConfirm: true });
  const m = mount(req);
  const idShown = () => m.text().includes("@riley:site.test");
  assert.ok(idShown(), "the request");
  await m.click("Accept");
  await m.settle();
  assert.match(m.text(), /They match/);
  assert.ok(idShown(), "the emoji step");
  await m.click("They match");
  await m.settle();
  assert.match(m.text(), /You verified Riley/);
  assert.ok(idShown(), "the result");
  m.unmount();
});

test("the peer cancels while the prompt asks → 'Verification cancelled', and nothing left to press", async () => {
  const { req, calls } = fakeRequest();
  const m = mount(req);
  assert.match(m.text(), /wants to verify you/, "vacuity: the prompt was asking");
  await act(async () => { req.phase = 5; req.emit("change"); });
  assert.match(m.text(), /Verification cancelled/);
  assert.equal(m.button("Accept"), undefined, "no Accept on a request that is gone");
  assert.deepEqual(calls, [], "we sent nothing back");
  m.unmount();
});

test("a self request is not consumed here", async () => {
  const { req } = fakeRequest({ isSelfVerification: true, otherUserId: "@casey:site.test" });
  const m = mount(req);
  assert.equal(m.cleared, 0, "Settings answers your own devices");
  assert.equal(m.button("Accept"), undefined);
  assert.doesNotMatch(m.text(), /wants to verify you/);
  m.unmount();
});
