// Discord's markdown subset → the HTML the render side already accepts
// (matrixHtml.ts allowlist). Run: node --test app/lib/markdown.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "./markdown.ts";

const id = (run: string) => escapeHtml(run);
const md = (text: string) => renderMarkdown(text, id);

test("plain text is unchanged and reports so; lines join with <br>", () => {
  assert.deepEqual(md("hello world"), { html: "hello world", changed: false });
  assert.deepEqual(md("a\nb"), { html: "a<br>b", changed: false });
  assert.deepEqual(md("x < y & z"), { html: "x &lt; y &amp; z", changed: false });
});

test("inline: bold, italic, underline, strike, bold-italic, spoiler, code", () => {
  assert.equal(md("**b**").html, "<strong>b</strong>");
  assert.equal(md("*i* and _i_").html, "<em>i</em> and <em>i</em>");
  assert.equal(md("__u__").html, "<u>u</u>");
  assert.equal(md("~~s~~").html, "<del>s</del>");
  assert.equal(md("***bi***").html, "<strong><em>bi</em></strong>");
  assert.equal(md("||secret||").html, '<span data-mx-spoiler>secret</span>');
  assert.equal(md("`a < b`").html, "<code>a &lt; b</code>");
  assert.equal(md("``a ` b``").html, "<code>a ` b</code>", "a longer backtick run closes only with its twin");
  assert.equal(md("**b**").changed, true);
});

test("inline formatting nests; code does not", () => {
  assert.equal(md("**bold *and italic***").html, "<strong>bold <em>and italic</em></strong>");
  assert.equal(md("||**s**||").html, "<span data-mx-spoiler><strong>s</strong></span>");
  assert.equal(md("`**not bold**`").html, "<code>**not bold**</code>");
});

test("a run inside formatting still goes through the inline renderer; code never does", () => {
  const seen: string[] = [];
  const spy = (run: string) => { seen.push(run); return run.toUpperCase(); };
  assert.equal(renderMarkdown("say **hi** `code`", spy).html, "SAY <strong>HI</strong> <code>code</code>");
  assert.deepEqual(seen, ["say ", "hi", " "]);
});

test("delimiters next to whitespace, unmatched and mid-word underscores stay literal", () => {
  assert.equal(md("x * a * y").html, "x * a * y");
  assert.equal(md("2 * 3 * 4").html, "2 * 3 * 4");
  assert.equal(md("**open").html, "**open");
  assert.equal(md("snake_case_name").html, "snake_case_name");
  assert.equal(md("~~x~").html, "~~x~");
  assert.equal(md("x * a * y").changed, false);
});

test("backslash escapes yield the literal character", () => {
  assert.deepEqual(md("\\*not bold\\*"), { html: "*not bold*", changed: true });
  assert.equal(md("a \\\\ b").html, "a \\ b");
  assert.equal(md("\\q").html, "\\q", "only markdown characters are escapable");
});

test("blocks: fences, quotes, headings, lists", () => {
  assert.equal(md("```js\nlet a = 1 < 2;\n```").html, '<pre><code class="language-js">let a = 1 &lt; 2;</code></pre>');
  assert.equal(md("```\nx\n```").html, "<pre><code>x</code></pre>");
  assert.equal(md("```bad lang\nx\n```").html, "```bad lang<br>x<br>```", "a fence with an invalid language token is not a fence");
  assert.equal(md("```\nunterminated").html, "<pre><code>unterminated</code></pre>");
  assert.equal(md("> a\n> b\nc").html, "<blockquote>a<br>b</blockquote>c");
  assert.equal(md(">>> a\nb\n> c").html, "<blockquote>a<br>b<br>&gt; c</blockquote>");
  assert.equal(md("# H1\n## H2\n### H3\n#### not").html, "<h1>H1</h1><h2>H2</h2><h3>H3</h3>#### not");
  assert.equal(md("- a\n* b\nc").html, "<ul><li>a</li><li>b</li></ul>c");
  assert.equal(md("1. a\n2. b").html, "<ol><li>a</li><li>b</li></ol>");
  assert.equal(md("> **q**").html, "<blockquote><strong>q</strong></blockquote>", "inline runs inside blocks");
  assert.equal(md("* first\n* second").html, "<ul><li>first</li><li>second</li></ul>");
  assert.equal(md("* a *").html, "<ul><li>a *</li></ul>", "a leading star is a bullet, as in Discord");
});

test("no tag outside the render allowlist is ever emitted", () => {
  const corpus = ["**a** _b_ __c__ ~~d~~ ||e|| `f` ***g***", "```x\ncode\n```", "> q\n# h\n- l\n1. o", "\\*", "<script>alert(1)</script> **x**"];
  const allowed = new Set(["strong", "em", "u", "del", "span", "code", "pre", "blockquote", "h1", "h2", "h3", "ul", "ol", "li", "br"]);
  for (const text of corpus) {
    for (const m of md(text).html.matchAll(/<\/?([a-z0-9]+)/g)) assert.ok(allowed.has(m[1]!), `${m[1]} from ${JSON.stringify(text)}`);
  }
});
