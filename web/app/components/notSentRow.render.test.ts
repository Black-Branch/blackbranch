// A message that failed to send must LOOK failed: the real MatrixMessageRow,
// mounted with the echo state the timeline hands it. "Not sent · Retry ·
// Delete" on the row, one line however many times a retry fails, and the memo
// row re-renders when only the echo state changes (the SDK mutates the same
// MatrixEvent in place, so `ev` alone never tells the memo anything moved).
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/components/notSentRow.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { NotSentLine } = await import("./NotSentLine.tsx");
const { retryEcho, dropEcho } = await import("../lib/localEcho.ts");
const { createRoot } = await import("react-dom/client");

const echo = {
  getId: () => "~!r:site.test:m1", getSender: () => "@me:site.test", getType: () => "m.room.message",
  getTs: () => Date.UTC(2026, 9, 24, 12, 0, 0), isRedacted: () => false,
  getContent: () => ({ msgtype: "m.text", body: "probe" }), getOriginalContent: () => ({ msgtype: "m.text", body: "probe" }),
  isEncrypted: () => false, isDecryptionFailure: () => false, status: "not_sent",
};
const room = {
  roomId: "!r:site.test",
  getMember: (id: string) => ({ userId: id, name: "me", rawDisplayName: "me", getMxcAvatarUrl: () => null, events: {} }),
  findEventById: () => null,
  currentState: { maySendRedactionForEvent: () => true },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThreads: () => [],
};

function click(el: Element) {
  return act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
}
const buttonNamed = (root: Element, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

// Stable across renders, as Timeline's useCallback'd handlers are — a fresh
// arrow per render would re-render the memo row on its own and make the memo
// test below pass whether or not rowPropsEqual compares `echo`.
const onReply = () => {};
const onReact = () => {};

async function mountRow(props: Record<string, unknown>) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  const render = (p: Record<string, unknown>) => act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, {
      ev: echo, room, myUserId: "@me:site.test", onReply, onReact, ...p,
    }));
  });
  await render(props);
  return { el, render, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}

test("NotSentLine says Not sent · Retry · Delete as a polite status", async () => {
  const el = dom.window.document.createElement("div");
  const root = createRoot(el);
  let retried = 0, deleted = 0;
  await act(async () => {
    root.render(React.createElement(NotSentLine, { onRetry: () => { retried++; }, onDelete: () => { deleted++; } }));
  });
  const status = el.querySelector('[role="status"]');
  assert.ok(status, "role=status");
  assert.match(status!.textContent ?? "", /^Not sent\s*·\s*Retry\s*·\s*Delete$/);
  await click(buttonNamed(el, "Retry")!);
  await click(buttonNamed(el, "Delete")!);
  assert.equal(retried, 1);
  assert.equal(deleted, 1);
  await act(async () => { root.unmount(); });
});

test("Retry and Delete are thumb-sized on a phone: each borrows the 44 × 44 tap area (≥ 40 × 36)", async () => {
  const el = dom.window.document.createElement("div");
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(NotSentLine, { onRetry: () => {}, onDelete: () => {} })); });
  for (const name of ["Retry", "Delete"]) {
    assert.ok(buttonNamed(el, name)!.classList.contains("tap-hit-44"), `${name} has the tap area`);
  }
  await act(async () => { root.unmount(); });
  // The class's area is the 44 × 44 pseudo-element (coarse pointers only, no layout cost).
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("app/globals.css", "utf8");
  const rule = css.slice(css.indexOf(".tap-hit-44::after {"), css.indexOf("}", css.indexOf(".tap-hit-44::after {")));
  assert.match(rule, /width: 44px;/);
  assert.match(rule, /height: 44px;/);
});

test("failed echo shows Not sent; Retry calls onRetry once", async () => {
  const retried: unknown[] = [];
  const r = await mountRow({ echo: "failed", onRetry: (e: unknown) => { retried.push(e); }, onDrop: () => {} });
  assert.match(r.el.textContent ?? "", /Not sent/);
  assert.match(r.el.textContent ?? "", /probe/, "the row keeps the text it failed to send");
  assert.equal(r.el.querySelector(".row-actions"), null, "no react/reply toolbar on a message nobody received");
  await click(buttonNamed(r.el, "Retry")!);
  assert.equal(retried.length, 1);
  assert.ok(retried[0] === echo, "onRetry gets the echo");
  await r.unmount();
});

test("Delete on a failed echo calls onDrop with the echo", async () => {
  const dropped: unknown[] = [];
  const r = await mountRow({ echo: "failed", onRetry: () => {}, onDrop: (e: unknown) => { dropped.push(e); } });
  await click(buttonNamed(r.el, "Delete")!);
  assert.ok(dropped.length === 1 && dropped[0] === echo);
  await r.unmount();
});

test("retry that fails again keeps one row", async () => {
  // Retry while still offline: the SDK flips the echo back to not_sent, the
  // timeline re-renders the same row with echo="failed" — never a second row.
  let resends = 0;
  const client = {
    resendEvent: () => { resends++; return Promise.reject(new Error("offline")); },
    cancelPendingEvent: () => {},
  };
  const onRetry = (e: never) => { void retryEcho(client as never, room as never, e); };
  const onDrop = (e: never) => { dropEcho(client as never, e); };
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await mountRow({ echo: "failed", onRetry, onDrop });
    await click(buttonNamed(r.el, "Retry")!);
    await r.render({ echo: "failed", onRetry, onDrop });
    await click(buttonNamed(r.el, "Retry")!);
    await r.render({ echo: "failed", onRetry, onDrop });
    assert.equal(r.el.querySelectorAll('[role="status"]').length, 1);
    assert.equal(r.el.querySelectorAll("[data-event-id]").length, 1);
    assert.equal(resends, 2);
    await r.unmount();
  } finally {
    console.error = orig;
  }
});

test("echo prop change re-renders the memo row", async () => {
  const onRetry = () => {};
  const onDrop = () => {};
  const r = await mountRow({ echo: "sent", onRetry, onDrop });
  assert.doesNotMatch(r.el.textContent ?? "", /Not sent/);
  await r.render({ echo: "failed", onRetry, onDrop });
  assert.match(r.el.textContent ?? "", /Not sent/);
  await r.render({ echo: "sent", onRetry, onDrop });
  assert.doesNotMatch(r.el.textContent ?? "", /Not sent/);
  await r.unmount();
});

test("a sending echo is faint and wordless; a sent one is neither", async () => {
  const sending = await mountRow({ echo: "sending" });
  const body = sending.el.querySelector("[data-echo]");
  assert.ok(body, "the row marks its echo state");
  assert.equal(body!.getAttribute("data-echo"), "sending");
  assert.match(body!.className, /opacity-/);
  assert.doesNotMatch(sending.el.textContent ?? "", /Sending|Not sent/);
  await sending.unmount();
  const sent = await mountRow({ echo: "sent" });
  assert.equal(sent.el.querySelector("[data-echo]"), null);
  await sent.unmount();
});
