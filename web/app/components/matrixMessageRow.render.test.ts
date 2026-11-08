// Cozy rows put the picture beside the message (client polish Task 24, k's QoL item 4).
//
// Discord's cozy row: the avatar in a left gutter, the name and time on one line, the text
// below it with its left edge at the name's; a grouped row has no avatar and shows its time in
// the gutter on hover; the reply quote, reactions and thread chip live in the text column.
// Compact keeps today's inline look (the avatar in the name line, text the full row width) and
// Bubbles is unchanged.
//
// ONE markup serves every layout: the head's avatar is the name line's first child, and the
// layout is a class on <html> (`mx-compact` / `mx-bubbles`; none = Cozy), so switching
// layouts never re-renders a row. In Cozy, globals.css gives the body column a left padding of
// the gutter token and lifts the avatar (and a grouped row's hover time) into that padding.
//
// jsdom has no layout: this mounts the real row with the real globals.css and asserts the
// STRUCTURE and the TOKEN TERMS the boxes are built from, never a pixel. The pixels are the
// Look's (look/24-rows.mjs on the throwaway pair).
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/matrixMessageRow.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../lib/testDom.ts";
import { stripCssComments, cssAtRuleBodies } from "../lib/testSource.ts";
import "../lib/testTsx.ts";
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { createRoot } = await import("react-dom/client");

const css = stripCssComments(readFileSync(new URL("../globals.css", import.meta.url), "utf8"));
const avatarSrc = readFileSync(new URL("./Avatar.tsx", import.meta.url), "utf8");

// The Community block of the real stylesheet, injected unchanged. jsdom applies no rule inside
// @media (the phone value is pinned from the source below), and this slice keeps Tailwind's own
// at-rules out of jsdom's parser.
const start = css.indexOf(".mx-row {");
const end = css.indexOf(".mx-bubbles .mx-row[data-gend]");
const community = css.slice(start, css.indexOf("}", end) + 1);
const style = dom.window.document.createElement("style");
// The head row's bar anchor sits beside the .row-actions rule (outside the block): add it too.
const barRule = /\.mx-row\[data-head\] > \.row-actions \{[^}]*\}/.exec(css)?.[0] ?? "";
style.textContent = `${community}\n${barRule}`;
dom.window.document.head.appendChild(style);

const html = dom.window.document.documentElement;
function layout(name: "cozy" | "compact" | "bubbles") {
  html.classList.toggle("mx-compact", name === "compact");
  html.classList.toggle("mx-bubbles", name === "bubbles");
}

type Opts = { id?: string; body?: string; replyTo?: string };
function ev(o: Opts = {}) {
  const content = {
    msgtype: "m.text",
    body: o.replyTo ? `> <@casey:site.test> the original\n\n${o.body ?? "hello world"}` : (o.body ?? "hello world"),
    ...(o.replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: o.replyTo } } } : {}),
  };
  return {
    getId: () => o.id ?? "$1", getSender: () => "@casey:site.test", getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 9, 26, 15, 4, 27), isRedacted: () => false,
    getContent: () => content, getOriginalContent: () => content,
    isEncrypted: () => false, isDecryptionFailure: () => false, status: null,
  };
}
const original = ev({ id: "$orig", body: "the original line" });
const room = {
  roomId: "!r:site.test",
  client: { fetchRoomEvent: () => new Promise(() => {}), decryptEventIfNeeded: () => Promise.resolve(), getUser: () => null, getUserId: () => "@me:site.test", on: () => {}, off: () => {}, removeListener: () => {} },
  getMember: (id: string) => ({ userId: id, name: id.slice(1, id.indexOf(":")), rawDisplayName: id.slice(1, id.indexOf(":")), getMxcAvatarUrl: () => null, events: {} }),
  findEventById: (id: string) => (id === "$orig" ? original : undefined),
  currentState: { maySendRedactionForEvent: () => true },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThreads: () => [],
  on: () => {}, off: () => {}, removeListener: () => {},
};

async function mount(props: Record<string, unknown>) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { room, myUserId: "@me:site.test", onReply: () => {}, onReact: () => {}, ...props }));
  });
  const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
  return { el, q, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}
const cs = (n: Element) => dom.window.getComputedStyle(n);

test("the stylesheet injected is the real Community block, and it holds the Cozy rules", () => {
  assert.ok(start > 0 && end > start, "the Community block was found in globals.css");
  assert.match(community, /\.mx-body \{[^}]*padding-left: var\(--mx-gutter\);/);
});

test("Cozy head row: avatar in the gutter, name and time on one line, text below in the body column", async () => {
  layout("cozy");
  const r = await mount({ ev: ev() });
  const body = r.q(".mx-body")!;
  const head = r.q(".mx-head")!;
  const avatar = r.q(".mx-avatar")!;
  assert.ok(body && head && avatar, "body column, name line and avatar rendered");
  // The gutter is the body column's left padding: avatar + the row's inset.
  assert.equal(cs(body).paddingLeft, "var(--mx-gutter)");
  // The avatar is the name line's first child, lifted out of the line into the gutter.
  assert.ok(head.firstElementChild === avatar, "the avatar is the name line's first child");
  assert.equal(cs(avatar).position, "absolute");
  assert.equal(cs(avatar).left, "calc(-1 * var(--mx-gutter))");
  assert.equal(cs(avatar).getPropertyValue("--mx-avatar-box").trim(), "var(--mx-gutter-avatar)", "the avatar is sized by the gutter token");
  // Its picture reads that box, falling back to the inline step (one chat line × Avatar size).
  const pic = avatar.firstElementChild as HTMLElement;
  assert.equal(pic.style.getPropertyValue("--avatar-size"), "var(--mx-avatar-box, calc(var(--avatar-line) * var(--chat-pfp-scale, 1)))");
  // Name and time share the line; the text is the line after it, inside the same column.
  assert.ok(head.querySelector(".mx-time"), "the time is on the name line");
  const text = [...r.el.querySelectorAll(".mx-text")].find((n) => n.textContent === "hello world")!;
  assert.ok(text && body.contains(text) && head.nextElementSibling === text, "the text is the line after the header, in the body column");
  // A head row is at least the avatar tall, so the picture never hangs into the next row.
  assert.equal(cs(head.parentElement!).minHeight, "var(--mx-gutter-avatar)");
  await r.unmount();
});

test("Cozy grouped row: an empty gutter, the time there on hover, and the text tooltip kept (mouse only — touch shows no title)", async () => {
  layout("cozy");
  const r = await mount({ ev: ev({ id: "$2" }), grouped: true });
  assert.equal(r.q(".mx-avatar"), null, "no avatar on a grouped row");
  assert.equal(r.q(".mx-head"), null, "no name line on a grouped row");
  const t = r.q(".mx-gutter-time")!;
  assert.ok(t, "the gutter time is rendered");
  assert.match(t.textContent ?? "", /^\d{1,2}:\d{2}/, "the short time, as text");
  const text = [...r.el.querySelectorAll(".mx-text")].find((n) => n.textContent === "hello world")!;
  assert.equal(text.getAttribute("title"), t.textContent, "the same short time stays the text's tooltip");
  assert.ok(t.classList.contains("mx-time"), "Community › Times hides it too");
  assert.equal(t.getAttribute("aria-hidden"), "true", "the tooltip already names it; read once");
  // It sits in the gutter, hidden until hover / focus.
  assert.equal(cs(t).position, "absolute");
  // The avatar slot plus the inset on each side: the row's edge to the text's edge.
  assert.equal(cs(t).left, "calc(-1 * var(--mx-gutter) - var(--mx-row-inset))");
  assert.equal(cs(t).width, "calc(var(--mx-gutter-avatar) + 2 * var(--mx-row-inset))");
  assert.equal(cs(t).visibility, "hidden");
  assert.equal(cs(r.q(".mx-body")!).paddingLeft, "var(--mx-gutter)", "grouped text aligns under the head's text");
  await r.unmount();
});

test("the hover time shows on hover (hover devices) and on keyboard focus, not on a clicked control's focus", () => {
  const hover = cssAtRuleBodies(css, "@media (hover: hover)").join("\n");
  assert.match(hover, /html:not\(\.mx-compact\):not\(\.mx-bubbles\) \.mx-row:hover \.mx-gutter-time \{ visibility: visible; \}/);
  assert.match(community, /html:not\(\.mx-compact\):not\(\.mx-bubbles\) \.mx-row:has\(:focus-visible\) \.mx-gutter-time \{ visibility: visible; \}/);
  assert.doesNotMatch(css, /:focus-within \.mx-gutter-time/, "a clicked or tapped pill keeps focus — :focus-within would pin the time on");
});

test("the gutter's hover time has no seconds, whatever the Timestamp format", async () => {
  layout("cozy");
  const r = await mount({ ev: ev({ id: "$7" }), grouped: true, tsFormat: "12s" });
  assert.match(r.q(".mx-gutter-time")!.textContent ?? "", /^\d{1,2}:\d{2} (AM|PM)$/, "12-hour, no seconds");
  assert.match(r.el.querySelector(".mx-text")!.getAttribute("title") ?? "", /^\d{1,2}:\d{2}:\d{2} (AM|PM)$/, "the tooltip keeps the chosen format");
  await r.unmount();
});

test("a head row's hover bar stands on the head's top padding: it never covers the quote or the name line", async () => {
  layout("cozy");
  const r = await mount({ ev: ev({ id: "$8", replyTo: "$orig" }), onJumpToReply: () => {} });
  assert.ok(barRule, "globals.css has the head row's bar anchor");
  const row = r.q(".mx-row")!;
  const bar = r.q(".row-actions")!;
  assert.ok(bar.parentElement === row, "the bar is the row's own child");
  assert.equal(cs(row).paddingTop, "var(--mx-head-pad)", "the head's top padding is the one term");
  assert.equal(cs(bar).top, "auto");
  assert.equal(cs(bar).bottom, "calc(100% - var(--mx-head-pad))", "its bottom edge is where the quote starts");
  await r.unmount();
  // A grouped row keeps the bar's own -top-2.5 (not the head's anchor).
  const g = await mount({ ev: ev({ id: "$9" }), grouped: true });
  assert.notEqual(cs(g.q(".row-actions")!).bottom, "calc(100% - var(--mx-head-pad))");
  await g.unmount();
  // Every layout sets the term; the bar follows it.
  assert.match(community, /\.mx-compact \.mx-row\[data-head\] \{ --mx-head-pad: 0\.25rem; \}/);
  assert.match(community, /\.mx-bubbles \.mx-row\[data-head\] \{[^}]*--mx-head-pad: 0\.375rem;/);
  assert.doesNotMatch(community, /\.mx-row\[data-head\] \{[^}]*padding-top: [0-9]/, "no layout sets the head's padding outside the term");
});

test("every scroller that hosts rows keeps the head row's bar reach clear at its top", () => {
  // The bar's height from its own terms: an h-8 button + the bar's py-1 + a 1px border each side.
  const row = readFileSync(new URL("./MatrixMessageRow.tsx", import.meta.url), "utf8");
  assert.match(row, /className="row-actions absolute right-3 -top-2\.5 gap-0\.5 rounded-lg px-1 py-1 /, "the bar's py-1");
  assert.match(row, /className="w-8 h-8 flex items-center justify-center rounded/, "the bar's h-8 buttons");
  assert.match(css, /\.row-actions \{[^}]*border: 1px solid var\(--glass-border\);/, "the bar's 1px border");
  const scroll = /\.mx-scroll \{([^}]*)\}/.exec(community)?.[1] ?? "";
  assert.match(scroll, /--mx-bar-h: calc\(2rem \+ 2 \* 0\.25rem \+ 2 \* 1px\);/, "the bar's height, by its terms");
  // A head row's bar reaches bar − head padding above the row, never more than the bar.
  assert.match(scroll, /padding-top: var\(--mx-bar-h\);/);
  // Every row scroller wears it, with no padding-top utility of their own to fight it.
  for (const f of ["../features/community/Timeline.tsx", "../features/community/ThreadPanel.tsx", "../features/dm/DmConversation.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /className=\{`flex-1 overflow-y-auto overscroll-y-contain mx-scroll pb-1 no-scrollbar \$\{/, `${f} scroller`);
  }
});

test("a narrow pane: the head shows the short time only; the full stamp is the tooltip", async () => {
  layout("cozy");
  const host = dom.window.document.createElement("div");
  host.setAttribute("data-mx-pane", "narrow");
  dom.window.document.body.appendChild(host);
  const el = dom.window.document.createElement("div");
  host.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(MatrixMessageRow as never, { ev: ev({ id: "$10" }), room, myUserId: "@me:site.test", tsFormat: "24" })); });
  const time = el.querySelector(".mx-head .mx-time") as HTMLElement;
  const day = time.querySelector(".mx-time-day") as HTMLElement;
  assert.ok(day, "the day part is its own span");
  assert.match(time.getAttribute("title") ?? "", /^(Today at|Yesterday at|\w{3} \d+) \d\d:\d\d$/, "the full stamp is the tooltip");
  assert.equal(time.textContent, time.getAttribute("title"), "a wide pane reads the full stamp");
  assert.equal(cs(day).display, "none", "a narrow pane hides the day part");
  await act(async () => { root.unmount(); });
  host.remove();
});

test("the head's picture is fetched at the gutter's size only in Cozy", async () => {
  const withPic = { ...room, getMember: (id: string) => ({ ...room.getMember(id), getMxcAvatarUrl: () => "mxc://site.test/pic" }) };
  const cozy = await mount({ ev: ev({ id: "$11" }), room: withPic });
  assert.match(cozy.q(".mx-avatar img")!.getAttribute("src") ?? "", /width=96&/, "Cozy: 40px at 2x, asked at Synapse's 96 crop so every surface shares the picture");
  await cozy.unmount();
  const compact = await mount({ ev: ev({ id: "$12" }), room: withPic, avatarStep: "xs", gutterAvatar: false });
  assert.match(compact.q(".mx-avatar img")!.getAttribute("src") ?? "", /width=32&/, "Compact: its own 16px (xs) at 2x, asked at Synapse's 32 crop");
  await compact.unmount();
});

test("reply quote, reactions and thread chip render inside the body column", async () => {
  layout("cozy");
  const r = await mount({ ev: ev({ id: "$3", replyTo: "$orig" }), reactions: [{ key: "👍", count: 2, mine: null, mxc: null, senders: ["@ann:site.test", "@bob:site.test"] }], threadCount: 1, lastReply: null, onOpenThread: () => {}, onJumpToReply: () => {} });
  const body = r.q(".mx-body")!;
  const quote = [...r.el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Jump to the original message")!;
  assert.ok(quote, "the quote rendered");
  assert.ok(body.contains(quote), "the reply quote is in the body column");
  const pill = [...r.el.querySelectorAll("button")].find((b) => b.classList.contains("rounded-full") && b.textContent?.includes("2"))!;
  assert.ok(pill && body.contains(pill), "the reaction is in the body column");
  const chip = [...r.el.querySelectorAll("button")].find((b) => b.textContent?.includes("1 reply"))!;
  assert.ok(chip && body.contains(chip), "the thread chip is in the body column");
  // The quote sits ABOVE the name line, outside the block the avatar is placed against — so a
  // reply does not push the picture off its name.
  const main = r.q(".mx-main")!;
  assert.equal(main.contains(quote), false, "the quote is above the avatar's block");
  assert.equal(cs(main).position, "relative");
  await r.unmount();
});

test("Compact keeps today's inline look: the avatar in the name line, no gutter", async () => {
  layout("compact");
  const r = await mount({ ev: ev({ id: "$4" }), avatarSize: 12 });
  const head = r.q(".mx-head")!;
  const avatar = r.q(".mx-avatar")!;
  assert.ok(head.firstElementChild === avatar, "the avatar leads the name line");
  assert.notEqual(cs(avatar).position, "absolute", "in the line, not the gutter");
  assert.equal(cs(avatar).getPropertyValue("--mx-avatar-box").trim(), "", "today's inline size, not the gutter's");
  assert.notEqual(cs(r.q(".mx-body")!).paddingLeft, "var(--mx-gutter)", "the text runs the full row width");
  const g = await mount({ ev: ev({ id: "$5" }), grouped: true });
  assert.notEqual(cs(g.q(".mx-gutter-time")!).display, "flex", "no gutter time in Compact");
  await g.unmount();
  await r.unmount();
  layout("bubbles");
  const b = await mount({ ev: ev({ id: "$6" }) });
  assert.notEqual(cs(b.q(".mx-avatar")!).position, "absolute", "Bubbles is unchanged: inline avatar");
  assert.notEqual(cs(b.q(".mx-body")!).paddingLeft, "var(--mx-gutter)");
  await b.unmount();
  layout("cozy");
});

test("Avatars off: the gutter collapses and the hover time goes with it", () => {
  assert.match(community, /\.mx-avatars-off \.mx-row \{ --mx-gutter-avatar: 0px; --mx-gutter: 0px; \}/);
  assert.match(community, /html:not\(\.mx-compact\):not\(\.mx-bubbles\):not\(\.mx-avatars-off\) \.mx-row \.mx-gutter-time \{/);
});

test("the gutter tokens: the scale's lg (40) base, md (32) on a narrow pane, × the same Avatar-size multiplier", () => {
  const rowRule = /\.mx-row \{([^}]*)\}/.exec(community)?.[1] ?? "";
  assert.match(rowRule, /--mx-row-inset: calc\(var\(--spacing, 0\.25rem\) \* 4\);/, "the row's inset: Tailwind's px-4, now one token");
  assert.match(rowRule, /padding-inline: var\(--mx-row-inset\);/, "the row's padding IS the inset token");
  // The picture token: a step of the one avatar scale (avatarSize.test.ts pins the scale).
  const tokenRule = /\.mx-row \{([^}]*--mx-gutter-avatar-base[^}]*)\}/.exec(community)?.[1] ?? "";
  assert.match(tokenRule, /--mx-gutter-avatar-base: var\(--avatar-lg\);/, "Discord's desktop cozy avatar");
  assert.match(tokenRule, /--mx-gutter-avatar: round\(calc\(var\(--mx-gutter-avatar-base\) \* var\(--chat-pfp-scale, 1\)\), 2px\);/);
  assert.match(rowRule, /--mx-gutter: calc\(var\(--mx-gutter-avatar\) \+ var\(--mx-row-inset\)\);/, "gutter = avatar + the row's inset");
  // Same multiplier as the inline avatar: the scale's chat-row steps are × --chat-pfp-scale.
  assert.match(avatarSrc, /scaled/);
  // The narrow value follows the PANE (MatrixView mode 1, the thread panel), one source: no
  // viewport rule for it.
  assert.match(community, /\[data-mx-pane="narrow"\] \.mx-row \{ --mx-gutter-avatar-base: var\(--avatar-md\); \}/, "Discord's phone cozy avatar, on any narrow pane");
  const phone = cssAtRuleBodies(css, "@media (max-width: 767px)").join("\n");
  assert.doesNotMatch(phone, /mx-gutter-avatar-base/, "one source: the pane marker, not the viewport");
  const timeline = readFileSync(new URL("../features/community/Timeline.tsx", import.meta.url), "utf8");
  assert.match(timeline, /data-mx-pane=\{compact \? "narrow" : undefined\}/, "the timeline marks mode 1");
  const thread = readFileSync(new URL("../features/community/ThreadPanel.tsx", import.meta.url), "utf8");
  assert.match(thread, /<div data-mx-pane="narrow" className="flex flex-col min-h-0 h-full">/, "the thread panel is always narrow");
});

test("the row's props are unchanged: no layout prop (the DM window reuses this row)", () => {
  const row = readFileSync(new URL("./MatrixMessageRow.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(row, /\blayout\?:/);
  assert.match(row, /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/, "vacuity anchor");
});
