// A poll started in another Matrix app (Element, FluffyChat — MSC3381) shows as a read-only
// card: the question, the answers, and "Vote in a Matrix app for now". Content that carries no
// readable poll shows its text fallback instead. Before this, the event was not a row at all,
// so a poll from Element simply did not exist on the site.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/pollStartCard.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
// The serializer Element Web uses to send a poll — the content under test is what it puts on the wire.
import { PollStartEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollStartEvent.js";
import { M_POLL_KIND_DISCLOSED } from "matrix-js-sdk/lib/@types/polls.js";

const { PollStartCard } = await import("./PollStartCard.tsx");
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { createRoot } = await import("react-dom/client");

const sdkPoll = () =>
  PollStartEvent.from("Best snack?", ["Chips", "Fruit", "Popcorn"], M_POLL_KIND_DISCLOSED).serialize() as {
    type: string;
    content: Record<string, unknown>;
  };

async function mountEl(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return {
    el: host,
    rerender: (next: React.ReactElement) => act(async () => { root.render(next); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}
const mountCard = (content: Record<string, unknown>) => mountEl(React.createElement(PollStartCard, { content }));

function answersOf(el: Element): string[] {
  return [...el.querySelectorAll("[data-poll-answer]")].map((a) => a.textContent ?? "");
}

test("card renders the content from matrix-js-sdk's PollStartEvent.from(question, answers, kind).serialize()", async () => {
  const { type, content } = sdkPoll();
  assert.equal(type, "org.matrix.msc3381.poll.start", "the SDK sends the unstable spelling");
  const m = await mountCard(content);
  const card = m.el.querySelector("[data-poll-start]");
  assert.ok(card, "the card renders");
  assert.equal(card!.querySelector("[data-poll-question]")?.textContent, "Best snack?");
  assert.deepEqual(answersOf(card!), ["Chips", "Fruit", "Popcorn"]);
  assert.match(card!.textContent ?? "", /Vote in a Matrix app for now/);
  assert.equal(card!.querySelector("button, input"), null, "read-only: nothing to press");
  assert.equal(card!.querySelector("[data-poll-fallback]"), null, "a readable poll shows no fallback text");
  await m.unmount();
});

test("the stable spelling (m.poll, m.text as a list) renders the same card", async () => {
  const m = await mountCard({
    "m.text": [{ body: "Best snack?\n1. Chips\n2. Fruit" }],
    "m.poll": {
      kind: "m.disclosed",
      max_selections: 1,
      question: { "m.text": [{ mimetype: "text/html", body: "<b>Best</b> snack?" }, { body: "Best snack?" }] },
      answers: [{ "m.id": "a", "m.text": [{ body: "Chips" }] }, { "m.id": "b", "m.text": [{ body: "Fruit" }] }],
    },
  });
  assert.equal(m.el.querySelector("[data-poll-question]")?.textContent, "Best snack?", "the plain-text representation, not the HTML one");
  assert.deepEqual(answersOf(m.el), ["Chips", "Fruit"]);
  await m.unmount();
});

test("text-only content renders the text", async () => {
  for (const content of [
    { "org.matrix.msc1767.text": "Best snack?\n1. Chips\n2. Fruit" },
    { "m.text": [{ body: "Best snack?\n1. Chips\n2. Fruit" }] },
    { "m.text": "Best snack?\n1. Chips\n2. Fruit" },
    { body: "Best snack?\n1. Chips\n2. Fruit" },
  ]) {
    const m = await mountCard(content);
    const fb = m.el.querySelector("[data-poll-fallback]");
    assert.ok(fb, `fallback for ${Object.keys(content)[0]}`);
    assert.equal(fb!.textContent, "Best snack?\n1. Chips\n2. Fruit");
    assert.equal(m.el.querySelectorAll("[data-poll-answer]").length, 0);
    assert.match(m.el.textContent ?? "", /Vote in a Matrix app for now/);
    await m.unmount();
  }
});

test("a poll with no question or no answers is not a poll: its fallback text shows", async () => {
  const m = await mountCard({
    "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": "Q?" }, answers: [] },
    "org.matrix.msc1767.text": "Q?",
  });
  assert.equal(m.el.querySelector("[data-poll-fallback]")?.textContent, "Q?");
  await m.unmount();
});

test("hostile content: markup is text, and at most 20 answers show (the SDK's own cap)", async () => {
  const answers = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, "org.matrix.msc1767.text": `<img src=x onerror=alert(${i})>` }));
  const m = await mountCard({
    "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": "<script>x</script>" }, answers },
  });
  assert.equal(m.el.querySelector("img, script"), null, "never parsed as HTML");
  assert.equal(m.el.querySelector("[data-poll-question]")?.textContent, "<script>x</script>");
  assert.equal(m.el.querySelectorAll("[data-poll-answer]").length, 20);
  await m.unmount();
});

// ─── In the channel: the row renders the card ────────────────────────────────

function ev(type: string, content: Record<string, unknown>, id = "$poll") {
  return {
    getId: () => id, getSender: () => "@casey:site.test", getType: () => type,
    getTs: () => Date.UTC(2026, 10, 5, 15, 4, 27), isRedacted: () => false,
    getContent: () => content, getOriginalContent: () => content, getWireContent: () => content,
    isEncrypted: () => type === "m.room.encrypted", isDecryptionFailure: () => false, status: null,
  };
}
const room = {
  roomId: "!r:site.test",
  client: { fetchRoomEvent: () => new Promise(() => {}), decryptEventIfNeeded: () => Promise.resolve(), getUser: () => null, getUserId: () => "@me:site.test", on: () => {}, off: () => {}, removeListener: () => {} },
  getMember: (id: string) => ({ userId: id, name: "casey", rawDisplayName: "casey", getMxcAvatarUrl: () => null, events: {} }),
  findEventById: () => undefined,
  currentState: { maySendRedactionForEvent: () => true },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThreads: () => [],
  on: () => {}, off: () => {}, removeListener: () => {},
};
const row = (e: ReturnType<typeof ev>) =>
  React.createElement(MatrixMessageRow as never, { ev: e, room, myUserId: "@me:site.test", onReply: () => {}, onReact: () => {} });

for (const type of ["org.matrix.msc3381.poll.start", "m.poll.start"]) {
  test(`a ${type} row in the channel shows the card with its three answers`, async () => {
    const m = await mountEl(row(ev(type, sdkPoll().content)));
    const card = m.el.querySelector("[data-event-id] [data-poll-start]");
    assert.ok(card, "the card sits in the row");
    assert.deepEqual(answersOf(card!), ["Chips", "Fruit", "Popcorn"]);
    await m.unmount();
  });
}

test("restart: a fresh mount of the same poll event renders the same card", async () => {
  const content = sdkPoll().content;
  const a = await mountEl(row(ev("org.matrix.msc3381.poll.start", content)));
  const first = a.el.querySelector("[data-poll-start]")?.textContent;
  await a.unmount();
  const b = await mountEl(row(ev("org.matrix.msc3381.poll.start", content)));
  assert.ok(first);
  assert.equal(b.el.querySelector("[data-poll-start]")?.textContent, first);
  await b.unmount();
});

test("retry: an encrypted poll shows the lock line, then the card once it decrypts", async () => {
  const m = await mountEl(row(ev("m.room.encrypted", { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" })));
  assert.ok(m.el.querySelector("[data-lock]"), "the lock line while waiting for the key");
  assert.equal(m.el.querySelector("[data-poll-start]"), null);
  await m.rerender(row(ev("org.matrix.msc3381.poll.start", sdkPoll().content)));
  assert.equal(m.el.querySelector("[data-lock]"), null);
  assert.deepEqual(answersOf(m.el.querySelector("[data-poll-start]")!), ["Chips", "Fruit", "Popcorn"]);
  await m.unmount();
});

// Vacuity anchor at the END: the card genuinely tells a poll from text-only content.
test("the card discriminates a poll from its fallback", async () => {
  const poll = await mountCard(sdkPoll().content);
  const text = await mountCard({ "org.matrix.msc1767.text": "just text" });
  assert.notEqual(poll.el.querySelectorAll("[data-poll-answer]").length, text.el.querySelectorAll("[data-poll-answer]").length);
  await poll.unmount();
  await text.unmount();
});
