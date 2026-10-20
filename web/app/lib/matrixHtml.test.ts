// Tests for the Matrix formatted_body sanitizer.
//
// This is the security-critical half of the HTML path, so it is a pure .ts module
// with real unit tests rather than logic buried in a component. jsdom supplies the
// DOMParser (it is already a web/ dependency).
//
// The threat model is NOT "a bridge sent us odd markup". `app/api/matrix/token`
// hands the browser a raw homeserver access token and there is no send proxy, so
// ANY logged-in user can PUT an event with an arbitrary formatted_body. These
// inputs are treated as hostile from an authenticated attacker.
//
// Run: node --test app/lib/matrixHtml.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { MxNode } from "./matrixHtml.ts";

// The site's own origin is an install value (site.origin, a build value): set before the module
// that reads it loads.
process.env.INSTALL_VALUES = JSON.stringify({ "site.origin": "https://example.tv" });
const {
  sanitizeMatrixHtml, safeHref, safeImgSrc, treeText, linkLabelText, treeHrefs, treeHasEmbed,
} = await import("./matrixHtml.ts");
const { deceptiveLinkHost } = await import("./linkGuard.ts");

const parser = new (new JSDOM().window.DOMParser)();
const san = (html: string) => sanitizeMatrixHtml(html, parser);

/** Every tag present in a tree, flattened. */
function tags(nodes: MxNode[]): string[] {
  const out: string[] = [];
  const visit = (ns: MxNode[]) => {
    for (const n of ns) if (n.t === "el") { out.push(n.tag); visit(n.children); }
  };
  visit(nodes);
  return out;
}
function find(nodes: MxNode[], tag: string): Extract<MxNode, { t: "el" }> | null {
  for (const n of nodes) {
    if (n.t !== "el") continue;
    if (n.tag === tag) return n;
    const hit = find(n.children, tag);
    if (hit) return hit;
  }
  return null;
}
/** The whole tree as a JSON string — for "this substring must appear NOWHERE" checks. */
const dump = (nodes: MxNode[]) => JSON.stringify(nodes);

// ─── XSS corpus ───────────────────────────────────────────────────────────────

test("script and style are dropped WHOLE, never unwrapped", () => {
  // The trap: unknown tags are unwrapped to keep their text, but DOMParser puts a
  // script's source in a TEXT child — unwrapping would splash raw JS into the
  // message as visible text (and hand an attacker a way to render anything).
  for (const html of [
    "<script>alert(1)</script>",
    "<script>var x = 'PWNED';</script>",
    "<style>body{display:none}</style>",
    "<noscript>PWNED</noscript>",
  ]) {
    const { nodes } = san(html);
    assert.ok(!/PWNED|alert|display:none/.test(dump(nodes)), `content survived: ${html}`);
  }
});

test("event-handler attributes never reach the tree", () => {
  for (const html of [
    `<img src="mxc://site.test/abc" onerror="alert(1)">`,
    `<a href="https://ok.com" onclick="alert(1)">x</a>`,
    `<p onmouseover="alert(1)">hi</p>`,
    `<b onload="alert(1)">hi</b>`,
  ]) {
    const { nodes } = san(html);
    assert.ok(!/onerror|onclick|onmouseover|onload|alert/i.test(dump(nodes)), `handler survived: ${html}`);
  }
});

test("dangerous href schemes are rejected", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",   // URL parsing strips the tab → still javascript:
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://x.com/abc",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeHref(bad), null, `accepted dangerous href: ${JSON.stringify(bad)}`);
  }
});

test("an anchor with a rejected href degrades to plain text, not a dead link", () => {
  const { nodes } = san(`<a href="javascript:alert(1)">click me</a>`);
  assert.equal(find(nodes, "a"), null, "the anchor must not survive");
  assert.equal(treeText(nodes), "click me", "its label should still be readable");
});

test("style attributes are dropped", () => {
  const { nodes } = san(`<p style="position:fixed;top:0">hi</p>`);
  assert.ok(!/position|fixed/.test(dump(nodes)));
});

test("class is never passed through as a string (Tailwind UI-spoofing)", () => {
  // Our stylesheet is Tailwind, so a free-text class list from a message body is a
  // UI-spoofing primitive: this would paint a full-page black overlay.
  const { nodes } = san(`<p class="fixed inset-0 z-50 bg-black">gotcha</p>`);
  assert.ok(!/fixed|inset-0|z-50|bg-black/.test(dump(nodes)), "raw class survived");
  assert.equal(treeText(nodes), "gotcha");
});

test("iframes, svg, forms and inputs are dropped", () => {
  for (const html of [
    `<iframe src="https://evil.com"></iframe>`,
    `<svg><use href="data:image/svg+xml,x"/></svg>`,
    `<form action="https://evil.com"><input name="password"></form>`,
    `<object data="https://evil.com"></object>`,
  ]) {
    const { nodes } = san(html);
    assert.ok(!/evil\.com|password/.test(dump(nodes)), `survived: ${html}`);
  }
});

// ─── image host policy ────────────────────────────────────────────────────────

test("mxc images are rewritten through our own media proxy", () => {
  assert.equal(
    safeImgSrc("mxc://site.test/jSinXjNiMJjowncgopKHOSEv"),
    "/api/matrix/media/download/site.test/jSinXjNiMJjowncgopKHOSEv"
  );
});

test("an mxc id cannot escape the proxy path", () => {
  for (const bad of [
    "mxc://site.test/../../../etc/passwd",
    "mxc://site.test/a/b",
    "mxc://../x",
    "mxc://site.test/",
    "mxc://site.test/abc?x=1",
  ]) {
    const out = safeImgSrc(bad);
    assert.ok(out === null || !out.includes(".."), `path escape via ${bad}: ${out}`);
  }
});

test("emote CDNs are allowed — our OWN client sends these", () => {
  // buildMatrixMessage.ts emits <img src="https://cdn.7tv.app/…" data-mx-emoticon>
  // for emotes in replies. An mxc-only policy would have broken site emotes.
  for (const ok of [
    "https://cdn.7tv.app/emote/01F9JATJB0000E0F0BJY6NY0W6/1x.gif",
    "https://cdn.betterttv.net/emote/55028cd2135896936880fdd7/1x.png",
    "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0",
    "https://example.tv/points.png",
  ]) {
    assert.ok(safeImgSrc(ok), `rejected a legitimate emote source: ${ok}`);
  }
});

test("arbitrary remote images are refused (tracking pixel / IP leak)", () => {
  // CSP is `img-src 'self' https: data: blob:`, so without this allowlist any
  // sender could log every reader's IP and user-agent by embedding a 1x1.
  for (const bad of [
    "https://evil.com/pixel.gif",
    "http://cdn.7tv.app/emote/x/1x.gif",   // plain http, even on an allowed host
    "https://cdn.7tv.app.evil.com/x.gif",  // suffix-confusion on the allowlist
    "data:image/png;base64,AAAA",
  ]) {
    assert.equal(safeImgSrc(bad), null, `accepted a remote image: ${bad}`);
  }
});

test("an image from a refused host vanishes rather than unwrapping", () => {
  const { nodes } = san(`<img src="https://evil.com/pixel.gif" alt="TRACKED">`);
  assert.equal(find(nodes, "img"), null);
  assert.ok(!dump(nodes).includes("TRACKED"), "alt text of a dropped image must not render");
});

// ─── structure ────────────────────────────────────────────────────────────────

test("mx-reply is stripped structurally", () => {
  // Real row. We render replies with our own ReplyPreview, so keeping the spec's
  // fallback would double every quoted message.
  const html =
    `<mx-reply><blockquote><a>In reply to</a> @bram:site.test<br/>matrix needs embeds</blockquote></mx-reply>` +
    `You don't?`;
  const { nodes } = san(html);
  assert.equal(treeText(nodes), "You don't?");
  assert.ok(!dump(nodes).includes("In reply to"));
});

test("depth is capped and reported, not silently truncated", () => {
  const bomb = "<blockquote>".repeat(200) + "deep" + "</blockquote>".repeat(200);
  const { nodes, truncated } = san(bomb);
  assert.equal(truncated, true, "hitting the cap must be reported so the UI can show it");
  const depth = (ns: MxNode[]): number =>
    Math.max(0, ...ns.map((n) => (n.t === "el" ? 1 + depth(n.children) : 0)));
  assert.ok(depth(nodes) <= 17, `tree too deep: ${depth(nodes)}`);
});

test("node count is capped and reported", () => {
  const { nodes, truncated } = san("<p>x</p>".repeat(1000));
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(nodes).length < 200_000, "budget did not bound the tree");
});

test("presentational tags fold onto their semantic twin", () => {
  assert.deepEqual(tags(san("<b>a</b><i>b</i><strike>c</strike>").nodes), ["strong", "em", "del"]);
});

test("unknown-but-harmless tags keep their content", () => {
  // <time> shows up in every Discord embed footer.
  const { nodes } = san(`<time datetime="2024-05-31T04:07:28Z">Friday, 31 May 2024</time>`);
  assert.equal(treeText(nodes), "Friday, 31 May 2024");
  assert.ok(!dump(nodes).includes("datetime"));
});

test("whitespace collapses like HTML, except inside <pre>", () => {
  assert.equal(treeText(san("<p>a   \n   b</p>").nodes), "a b");
  assert.ok(treeText(san("<pre><code>a\n  b</code></pre>").nodes).includes("\n  b"),
    "<pre> must keep its formatting");
});

// ─── real bridged shapes (verbatim from our Synapse) ──────────────────────────

test("a Discord custom emoji becomes an inline emote", () => {
  const html = `Dude I feel so defeated <img data-mx-emoticon src="mxc://site.test/jSinXjNiMJjowncgopKHOSEv" alt=":peepoSad:" title=":peepoSad:" height="32"/>`;
  const { nodes } = san(html);
  const img = find(nodes, "img")!;
  assert.equal(img.attrs.emote, true, "must be flagged as an emote, not a block image");
  assert.equal(img.attrs.alt, ":peepoSad:");
  assert.equal(img.attrs.height, 32);
  assert.ok(img.attrs.src!.startsWith("/api/matrix/media/download/"));
});

test("a Discord rich embed keeps its structure and accent", () => {
  const html =
    `<blockquote class="discord-embed" background-color="#1DA1F2">` +
    `<p class="discord-embed-author"><span><a href="https://twitter.com/DylanBurns1776">Dylan Burns (@DylanBurns1776)</a></span></p>` +
    `<p class="discord-embed-description">A Youtuber with much bigger reach</p>` +
    `</blockquote>`;
  const { nodes } = san(html);
  const bq = find(nodes, "blockquote")!;
  assert.equal(bq.attrs.role, "embed");
  assert.equal(bq.attrs.accent, "#1DA1F2", "the embed's accent colour should survive");
  assert.ok(find(nodes, "a"), "the author link should survive");
  assert.ok(treeText(nodes).includes("much bigger reach"));
});

test("a bogus accent colour is refused", () => {
  const { nodes } = san(`<blockquote class="discord-embed" background-color="url(javascript:alert(1))">x</blockquote>`);
  assert.equal(find(nodes, "blockquote")!.attrs.accent, undefined);
});

test("nested <p> from a real embed survives the parser's auto-closing", () => {
  // mautrix emits `<p class="discord-embed-description"><p>…</p></p>`, which is
  // invalid HTML — DOMParser auto-closes the outer <p>, so these arrive as
  // SIBLINGS, not nested. Pinned so nobody 'fixes' the renderer to assume nesting.
  const { nodes } = san(`<p class="discord-embed-description"><p>inner</p></p>`);
  assert.ok(treeText(nodes).includes("inner"));
});

test("tables, lists and code blocks from real messages render", () => {
  const { nodes } = san(
    `<ul><li>one</li><li>two</li></ul><table><tr><th>h</th><td>d</td></tr></table><pre><code class="language-js">x=1</code></pre>`
  );
  const t = tags(nodes);
  for (const want of ["ul", "li", "table", "tr", "th", "td", "pre", "code"]) {
    assert.ok(t.includes(want), `lost <${want}>`);
  }
  assert.equal(find(nodes, "code")!.attrs.lang, "js");
});

test("a garbage code language is not passed through", () => {
  // Real row: Discord fences produce class="language-client.on(Events.MessageCreate,"
  const { nodes } = san(`<pre><code class="language-client.on(Events.MessageCreate,">x</code></pre>`);
  assert.equal(find(nodes, "code")!.attrs.lang, undefined);
});

test("HTML entities are decoded by the parser, not left literal", () => {
  assert.equal(treeText(san(`&quot;The Founding fathers&quot;`).nodes), `"The Founding fathers"`);
  assert.equal(treeText(san(`a &amp;&amp; b`).nodes), "a && b");
});

// ─── link labels (feed the link-label guard) ──────────────────────────────────

test("a link label ignores img alt text — the reader cannot see it", () => {
  // REGRESSION GUARD. treeText counted <img alt> toward the label, but the
  // renderer paints the image and never its alt. A 1x1 transparent emote with
  // alt="@" therefore injected an INVISIBLE character into the label, which was
  // enough to trip the handle carve-out and suppress the phishing warning on a
  // link whose visible text read simply "paypal.com". Caught by security review.
  const { nodes } = san(
    `<a href="https://evil.example/login"><img data-mx-emoticon src="mxc://site.test/AAAA" alt="(@">paypal.com)</a>`
  );
  const a = find(nodes, "a")!;
  assert.equal(linkLabelText(a.children), "paypal.com)",
    "alt text must not reach the label the guard judges");
  assert.equal(
    deceptiveLinkHost(linkLabelText(a.children), a.attrs.href!),
    "evil.example",
    "the warning must survive an invisible image trying to fake a handle"
  );
  // treeText still sees alt — it is the copy/search projection, not the label.
  assert.ok(treeText(a.children).includes("(@"));
});

// ─── link extraction (feeds LinkPreview) ──────────────────────────────────────

test("preview URLs come from real anchors, not a regex over the body", () => {
  // The bug this replaces: a greedy /https?:\/\/[^\s]+/ ran past the closing paren
  // of a markdown link, yielding both "…/y)" and "…/y" as distinct strings — two
  // cards, one of which resolved to Bluesky's empty SPA shell.
  const html = `<a href="https://bsky.app/profile/natalie.sh/post/3m5hh5rnqwk2v">Some post</a>`;
  assert.deepEqual(treeHrefs(san(html).nodes), ["https://bsky.app/profile/natalie.sh/post/3m5hh5rnqwk2v"]);
});

test("non-http link targets are not offered for preview", () => {
  const { nodes } = san(`<a href="matrix:roomid/elYPZv">a room</a>`);
  assert.deepEqual(treeHrefs(nodes), [], "matrix: links are navigable but not previewable");
});

test("a matrix.to user link survives sanitisation with its href intact (the pill's input)", () => {
  const { nodes } = san(`hi <a href="https://matrix.to/#/@discord_100000000000000001:site.test">Casey</a>`);
  const a = find(nodes, "a")!;
  assert.equal(a.attrs.href, "https://matrix.to/#/@discord_100000000000000001:site.test");
  assert.equal(treeText([a]), "Casey");
});

test("a matrix.to pill's href is excluded from link previews; an ordinary link is not", () => {
  const html = `hi <a href="https://matrix.to/#/@discord_100000000000000001:site.test">Casey</a> see <a href="https://example.com/post">this</a>`;
  assert.deepEqual(treeHrefs(san(html).nodes), ["https://example.com/post"],
    "a pill is a person, not a page — it must not trigger an /api/og fetch");
});

test("empty and malformed input is handled", () => {
  for (const html of ["", "   ", "<", "<p>", "</p>", "<<<>>>"]) {
    assert.doesNotThrow(() => san(html), `threw on ${JSON.stringify(html)}`);
  }
});

test("treeHasEmbed: a bridged Discord embed anywhere in the tree", () => {
  const embed = `<p>look</p><blockquote class="discord-embed" background-color="#6364FF"><p class="discord-embed-description">x</p></blockquote>`;
  assert.equal(treeHasEmbed(san(embed).nodes), true);
  assert.equal(treeHasEmbed(san(`<p><span>${embed}</span></p>`).nodes), true, "nested");
  assert.equal(treeHasEmbed(san(`<p><a href="https://x.com/a/status/1">link</a></p>`).nodes), false);
  assert.equal(treeHasEmbed(san(`<p class="discord-embed-description">orphan role, no embed</p>`).nodes), false, "only the embed root counts");
  assert.equal(treeHasEmbed([]), false);
  assert.equal(treeHasEmbed(san(`<span class="discord-embed">x</span>`).nodes), false, "only a blockquote is an embed — the renderer draws nothing else as one");
  assert.equal(treeHasEmbed(san(`<p class="discord-embed">x</p>`).nodes), false, "only a blockquote is an embed — the renderer draws nothing else as one");
});

test("data-mx-spoiler on a span becomes a spoiler attr; a reason is kept and capped", () => {
  const plain = find(san(`<span data-mx-spoiler>the butler</span>`).nodes, "span")!;
  assert.equal(plain.attrs.spoiler, true);
  assert.equal(plain.attrs.spoilerReason, undefined, "an empty attribute is no reason");
  const reasoned = find(san(`<span data-mx-spoiler="  ending  ">the butler</span>`).nodes, "span")!;
  assert.equal(reasoned.attrs.spoilerReason, "ending");
  const long = find(san(`<span data-mx-spoiler="${"r".repeat(150)}">x</span>`).nodes, "span")!;
  assert.equal(long.attrs.spoilerReason?.length, 100);
});

test("data-mx-spoiler on any other tag is ignored", () => {
  for (const html of [`<p data-mx-spoiler>x</p>`, `<a href="https://e.example" data-mx-spoiler>x</a>`, `<strong data-mx-spoiler>x</strong>`]) {
    assert.ok(!/spoiler/.test(dump(san(html).nodes)), html);
  }
});
