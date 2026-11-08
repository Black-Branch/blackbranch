// The long-press sheet (client polish F9 + F11): ONE bottom sheet — the three quick reactions and
// ＋ on top, every action below as a 48 px row — and its Reactions view, which says who reacted.
// The desktop ⋯ menu renders the same items (msgMenuItems), so the two never disagree on what a
// message offers.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/components/messageSheet.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
const { MessageSheet } = await import("./MessageSheet.tsx");
const { msgMenuItems } = await import("./msgMenuItems.tsx");
const { MsgContextMenu } = await import("./MsgContextMenu.tsx");
const { createRoot } = await import("react-dom/client");

const doc = dom.window.document;
// ContextMenu's focus check reads the HTMLElement global, which the harness does not install.
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = dom.window.HTMLElement;
const noop = () => {};
const fullCtx = {
  onReact: noop, onReply: noop, onThread: noop, onMention: noop, onEdit: noop, onCopy: noop,
  onCopyLink: noop, onPin: noop, pinned: false, onDelete: noop,
};

async function mount(el: React.ReactElement) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return {
    rerender: (next: React.ReactElement) => act(async () => { root.render(next); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
// jsdom's selector engine never matches an emoji inside [attr="…"]; compare the attribute instead.
const byAttr = (root: ParentNode, attr: string, value: string) =>
  [...root.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === value) ?? null;
const sheet = () => doc.querySelector('[role="dialog"]');
const rowLabels = (root: Element) => [...root.querySelectorAll("[data-sheet-item]")].map((b) => b.textContent?.trim());

function sheetEl(p: Partial<Parameters<typeof MessageSheet>[0]> = {}) {
  return React.createElement(MessageSheet, {
    open: true, onClose: noop, view: { kind: "actions" }, quickReactions: ["👍", "❤️", "😂"],
    onReact: noop, onMore: noop, items: msgMenuItems(fullCtx, "sent"), reactions: [], nameOf: (id: string) => id,
    ...p,
  });
}

test("actions: 3 quick + ＋, then items in the order above", async () => {
  const m = await mount(sheetEl());
  const s = sheet();
  assert.ok(s, "the sheet is open");
  const quick = [...s!.querySelectorAll("[data-sheet-quick] button")].map((b) => b.getAttribute("aria-label"));
  assert.deepEqual(quick, ["React with 👍", "React with ❤️", "React with 😂", "More reactions"]);
  // The ＋ is the sheet's React, so the list does not repeat it.
  assert.deepEqual(rowLabels(s!), ["Reply", "Reply in thread", "Mention", "Edit", "Copy text", "Copy link", "Pin message", "Delete"]);
  for (const b of s!.querySelectorAll("[data-sheet-item]")) assert.ok(b.classList.contains("h-12"), "each row is 48 px");
  // The quick row comes BEFORE the list.
  const q = s!.querySelector("[data-sheet-quick]")!, first = s!.querySelector("[data-sheet-item]")!;
  assert.ok(q.compareDocumentPosition(first) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  await m.unmount();
});

test("the item order is one list for the sheet and the ⋯ menu", async () => {
  assert.deepEqual(msgMenuItems(fullCtx, "sent").map((i) => i.id),
    ["react", "reply", "thread", "mention", "edit", "copy", "copylink", "pin", "delete"]);
  assert.equal(msgMenuItems({ ...fullCtx, pinned: true }, "sent").find((i) => i.id === "pin")?.label, "Unpin message");
  const m = await mount(React.createElement(MsgContextMenu, { ...fullCtx, x: 10, y: 10, onClose: noop }));
  const labels = [...doc.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim());
  assert.deepEqual(labels, ["React", "Reply", "Reply in thread", "Mention", "Edit", "Copy text", "Copy link", "Pin message", "Delete"]);
  await m.unmount();
});

test("a quick reaction reacts and closes; ＋ opens the picker", async () => {
  const reacted: string[] = [];
  let closed = 0, more = 0;
  const m = await mount(sheetEl({ onReact: (k: string) => { reacted.push(k); }, onClose: () => { closed++; }, onMore: () => { more++; } }));
  await click(byAttr(sheet()!, "aria-label", "React with ❤️")!);
  assert.deepEqual(reacted, ["❤️"]);
  assert.equal(closed, 1);
  await click(sheet()!.querySelector('[aria-label="More reactions"]')!);
  assert.equal(more, 1);
  await m.unmount();
});

test("Delete needs its confirm tap", async () => {
  let deleted = 0, closed = 0;
  const m = await mount(sheetEl({ items: msgMenuItems({ ...fullCtx, onDelete: () => { deleted++; } }, "sent"), onClose: () => { closed++; } }));
  const del = () => [...sheet()!.querySelectorAll("[data-sheet-item]")].find((b) => /Delete/.test(b.textContent ?? ""))!;
  await click(del());
  assert.equal(deleted, 0, "one tap does not delete");
  assert.equal(del().textContent?.trim(), "Delete message?", "the armed row says what the next tap does");
  assert.equal(closed, 0, "the sheet stays for the second tap");
  await click(del());
  assert.equal(deleted, 1);
  assert.equal(closed, 1);
  await m.unmount();
});

test("the ⋯ menu's Delete asks the same question", async () => {
  let deleted = 0;
  const m = await mount(React.createElement(MsgContextMenu, { ...fullCtx, onDelete: () => { deleted++; }, x: 10, y: 10, onClose: noop }));
  const del = () => [...doc.querySelectorAll('[role="menuitem"]')].find((b) => /Delete/.test(b.textContent ?? ""))!;
  await click(del());
  assert.equal(deleted, 0);
  assert.equal(del().textContent?.trim(), "Delete message?");
  await click(del());
  assert.equal(deleted, 1);
  await m.unmount();
});

test("a failed echo shows Retry/Delete/Copy only; Retry calls ctx.onRetry, Delete calls ctx.onDrop", async () => {
  let retried = 0, dropped = 0, redacted = 0;
  const ctx = { ...fullCtx, onDelete: () => { redacted++; }, onRetry: () => { retried++; }, onDrop: () => { dropped++; } };
  const items = msgMenuItems(ctx, "failed");
  assert.deepEqual(items.map((i) => i.label), ["Retry", "Delete", "Copy text"]);
  const m = await mount(sheetEl({ items, quickReactions: [] }));
  assert.equal(sheet()!.querySelector("[data-sheet-quick]"), null, "nobody received it: nothing to react to");
  const byLabel = (l: string) => [...sheet()!.querySelectorAll("[data-sheet-item]")].find((b) => b.textContent?.trim() === l)!;
  await click(byLabel("Retry"));
  assert.equal(retried, 1);
  await m.rerender(sheetEl({ items, quickReactions: [] }));
  // Removing a message nobody received is the Not-sent line's one-tap Delete, not a redaction.
  await click(byLabel("Delete"));
  assert.equal(dropped, 1);
  assert.equal(redacted, 0, "an unsent echo is dropped, never redacted");
  await m.unmount();
});

test("reactions view lists names", async () => {
  const names: Record<string, string> = { "@ann:site.test": "Ann", "@bob:site.test": "Bob", "@cy:site.test": "Cy" };
  const reactions = [
    { key: "👍", count: 2, mine: null, mxc: null, senders: ["@ann:site.test", "@bob:site.test"] },
    { key: "🔥", count: 1, mine: null, mxc: null, senders: ["@cy:site.test"] },
  ];
  const m = await mount(sheetEl({ view: { kind: "reactions", key: "👍" }, reactions, nameOf: (id: string) => names[id] ?? id }));
  const s = sheet()!;
  assert.equal(s.getAttribute("aria-label"), "Reactions");
  const list = () => [...s.querySelectorAll("[data-reactor]")].map((r) => r.textContent?.trim());
  assert.deepEqual(list(), ["Ann", "Bob"], "the pressed pile's people, in the order they reacted");
  await click(byAttr(s, "data-reaction-tab", "🔥")!);
  assert.deepEqual(list(), ["Cy"], "another pile's tab shows its people");
  await m.unmount();
});

test("closed renders nothing", async () => {
  const m = await mount(sheetEl({ open: false }));
  assert.equal(sheet(), null);
  await m.unmount();
});
