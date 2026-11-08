// A picture, video, audio or file sent with text shows that text under it (the
// composer posts it as `body` beside the file's own `filename`); one sent bare,
// or by a client that puts the file name in `body`, shows no caption.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/matrixMediaCaption.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";

const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { createRoot } = await import("react-dom/client");

function ev(content: Record<string, unknown>) {
  return {
    getId: () => "$m", getSender: () => "@casey:site.test", getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 10, 5, 15, 4, 27), isRedacted: () => false,
    getContent: () => content, getOriginalContent: () => content,
    isEncrypted: () => false, isDecryptionFailure: () => false, status: null,
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

async function mount(content: Record<string, unknown>) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { ev: ev(content), room, myUserId: "@me:site.test", onReply: () => {}, onReact: () => {} }));
  });
  return { el, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}

const media = (msgtype: string, extra: Record<string, unknown>) => ({ msgtype, url: "mxc://site.test/x", info: { mimetype: "x/y", size: 10 }, ...extra });

for (const [msgtype, tag, filename] of [
  ["m.image", "img.img-shadow-chat", "a.png"], ["m.video", "video", "clip.mp4"], ["m.audio", "audio", "song.ogg"], ["m.file", "button", "doc.pdf"],
] as const) {
  test(`${msgtype} with a caption: the media, then the caption`, async () => {
    const m = await mount(media(msgtype, { body: "look", filename }));
    const player = m.el.querySelector(tag);
    const cap = m.el.querySelector("[data-caption]");
    assert.ok(player, `${msgtype} renders its ${tag}`);
    assert.ok(cap, "the caption renders");
    assert.equal(cap!.textContent, "look");
    assert.ok(player!.compareDocumentPosition(cap!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "under the media");
    if (tag !== "button") assert.equal(player!.getAttribute(tag.startsWith("img") ? "alt" : "title"), filename, "named by its filename, not the caption");
    await m.unmount();
  });

  test(`${msgtype} sent bare: no caption`, async () => {
    const a = await mount(media(msgtype, { body: filename, filename }));
    assert.equal(a.el.querySelector("[data-caption]"), null, "body equal to filename is the name");
    await a.unmount();
    const b = await mount(media(msgtype, { body: filename }));
    assert.equal(b.el.querySelector("[data-caption]"), null, "no filename (bridges, older clients): body is the name");
    await b.unmount();
  });
}

// ── A link in a caption gets the same preview card a plain line gets (Task 10b) ──
// The card sits under the media AND the caption, in that order. `at` finds the one
// element a position is compared against and fails if it is missing, so a card that
// never rendered cannot pass the ordering check by comparing against nothing.
const URL_ = "https://example.test/story";
function at(root: Element, sel: string, what: string): Element {
  const hit = root.querySelector(sel);
  assert.ok(hit, `${what} (${sel}) is not in the row — the position cannot be checked`);
  return hit!;
}
const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
const CARD = "[data-link-card]";
const tick = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

for (const [msgtype, tag, filename] of [
  ["m.image", "img.img-shadow-chat", "a.png"], ["m.video", "video", "clip.mp4"], ["m.audio", "audio", "song.ogg"], ["m.file", "button", "doc.pdf"],
] as const) {
  test(`${msgtype} whose caption holds a link: media, caption, then the card a plain line shows`, async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ title: "The story", siteName: "example" }), { status: 200, headers: { "content-type": "application/json" } }));
    const plain = await mount({ msgtype: "m.text", body: `read ${URL_}` });
    await tick();
    const plainCard = at(plain.el, CARD, "the plain line's card");
    assert.equal(plainCard.getAttribute("href"), URL_);
    const plainHtml = plainCard.outerHTML;
    await plain.unmount();

    const m = await mount(media(msgtype, { body: `read ${URL_}`, filename }));
    await tick();
    const player = at(m.el, tag, "the media");
    const cap = at(m.el, "[data-caption]", "the caption");
    const card = at(m.el, CARD, "the caption's card");
    assert.equal(card.outerHTML, plainHtml, "the very card the plain line renders");
    assert.ok(follows(player, cap), "the caption is under the media");
    assert.ok(follows(cap, card), "the card is under the caption");
    assert.equal(m.el.querySelectorAll(CARD).length, 1, "one card for one link");
    await m.unmount();
  });
}

test("a media event sent bare (its body is the file name) gets no card", async () => {
  const m = await mount(media("m.file", { body: URL_, filename: URL_ }));
  await tick();
  assert.equal(m.el.querySelector(CARD), null, "a file's name is not a caption, so it is never unfurled");
  await m.unmount();
});
