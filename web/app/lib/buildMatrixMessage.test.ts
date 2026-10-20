// Replies and mentions must carry a NAME the reader recognises and a pill every
// client understands (matrix.to anchor + MSC3952 m.mentions), not a raw
// `@discord_7970…` id. Run: node --test app/lib/buildMatrixMessage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatrixMessage, buildEditContent } from "./buildMatrixMessage.ts";

const GHOST = "@discord_100000000000000001:site.test";
const REPLY = { eventId: "$orig", roomId: "!room:site.test", senderUserId: GHOST, senderLabel: "Casey", body: "hello there" };

test("a reply shows the sender's label in the quote and pills the sender", () => {
  const c = buildMatrixMessage("yes", {}, REPLY);
  assert.equal(c.body, `> <${GHOST}> hello there\n\nyes`, "the plain fallback keeps the spec's mxid form");
  assert.match(c.formatted_body!, /<a href="https:\/\/matrix\.to\/#\/!room:site\.test\/\$orig">In reply to<\/a> <a href="https:\/\/matrix\.to\/#\/@discord_100000000000000001:site\.test">Casey<\/a><br\/>hello there/);
  assert.doesNotMatch(c.formatted_body!, /In reply to<\/a> @discord_/, "the visible name must be the label, not the id");
  assert.deepEqual(c["m.mentions"], { user_ids: [GHOST] });
});

test("a resolved @mention becomes a pill and an intentional mention", () => {
  const c = buildMatrixMessage("hi @Casey how are you", {}, undefined, [{ label: "Casey", userId: GHOST }]);
  assert.equal(c.body, "hi @Casey how are you");
  assert.equal(c.format, "org.matrix.custom.html");
  assert.equal(c.formatted_body, `hi <a href="https://matrix.to/#/${GHOST}">Casey</a> how are you`);
  assert.deepEqual(c["m.mentions"], { user_ids: [GHOST] });
});

test("an @word nobody picked stays text and mentions no one", () => {
  const c = buildMatrixMessage("hi @Casey", {}, undefined, [{ label: "Someone", userId: "@x:site.test" }]);
  assert.equal(c.formatted_body, undefined);
  assert.equal(c["m.mentions"], undefined);
});

test("a mention label is matched as a whole token, not a prefix", () => {
  const c = buildMatrixMessage("@Caseyx is not @Casey", {}, undefined, [{ label: "Casey", userId: GHOST }]);
  assert.equal(c.formatted_body, `@Caseyx is not <a href="https://matrix.to/#/${GHOST}">Casey</a>`);
});

test("a reply that also mentions someone lists both ids once", () => {
  const c = buildMatrixMessage("@Casey yes", {}, REPLY, [{ label: "Casey", userId: GHOST }]);
  assert.deepEqual(c["m.mentions"], { user_ids: [GHOST] });
});

test("plain text stays body-only (the bridge-empty-message guard)", () => {
  const c = buildMatrixMessage("just words", { OMEGALUL: { url: "https://cdn.7tv.app/x", zeroWidth: false } });
  assert.equal(c.format, undefined);
  assert.equal(c.formatted_body, undefined);
  assert.equal(c["m.mentions"], undefined);
});

test("html in a label or body is escaped inside the pill markup", () => {
  const c = buildMatrixMessage("hi @<b>", {}, undefined, [{ label: "<b>", userId: "@evil:site.test" }]);
  assert.equal(c.formatted_body, `hi <a href="https://matrix.to/#/@evil:site.test">&lt;b&gt;</a>`);
});

test("the HTML renderer draws a matrix.to user link as a pill", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/MatrixHtml.tsx"), "utf8"));
  assert.ok(src.includes('const USER_PILL = /^https:\\/\\/matrix\\.to\\/#\\/(@[^/?#]+)$/;'), "the pill pattern is the spec's");
  assert.match(src, /USER_PILL\.exec\(attrs\.href\)/, "Anchor must test the href against USER_PILL");
  // A hostile formatted_body can put a lone "%" in the mxid (it survives safeHref,
  // which does not validate percent-encoding), and decodeURIComponent throws on
  // that — regression guard for a render-crashing DoS.
  assert.match(src, /try \{\s*title = decodeURIComponent\(title\);\s*\} catch/,
    "a malformed percent-escape in the pill's mxid must not throw during render");
});

const ALICE = "@alice:site.test";
const BOB = "@bob:site.test";
const MOD = "@modghost:site.test";

test("a display name with a space in it resolves as one mention, not two words", () => {
  const c = buildMatrixMessage("hi @First Last there", {}, undefined, [{ label: "First Last", userId: GHOST }]);
  assert.equal(c.formatted_body, `hi <a href="https://matrix.to/#/${GHOST}">First Last</a> there`);
  assert.deepEqual(c["m.mentions"], { user_ids: [GHOST] });
});

test("a label with regex metacharacters resolves whole and does not match its own prefix", () => {
  const c = buildMatrixMessage("hey @k (mod) and @k", {}, undefined, [{ label: "k (mod)", userId: MOD }]);
  assert.equal(c.formatted_body, `hey <a href="https://matrix.to/#/${MOD}">k (mod)</a> and @k`);
  assert.deepEqual(c["m.mentions"], { user_ids: [MOD] });
});

test("a mention at the very start of the text, and one at the very end with trailing punctuation, both resolve", () => {
  const c = buildMatrixMessage("@Alice hi @Bob!", {}, undefined, [
    { label: "Alice", userId: ALICE },
    { label: "Bob", userId: BOB },
  ]);
  assert.equal(
    c.formatted_body,
    `<a href="https://matrix.to/#/${ALICE}">Alice</a> hi <a href="https://matrix.to/#/${BOB}">Bob</a>!`
  );
  assert.deepEqual(c["m.mentions"], { user_ids: [ALICE, BOB] });
});

test("a mention followed by multiple punctuation marks resolves with all of them trailing", () => {
  const c = buildMatrixMessage("@Casey!!", {}, undefined, [{ label: "Casey", userId: GHOST }]);
  assert.equal(c.formatted_body, `<a href="https://matrix.to/#/${GHOST}">Casey</a>!!`);
  assert.deepEqual(c["m.mentions"], { user_ids: [GHOST] });
});

test("MatrixMessageRow builds link previews from real anchors AND bare URLs in the rendered text", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/MatrixMessageRow.tsx"), "utf8")
  );
  assert.match(
    src,
    /uniqueUrls\(\[\.\.\.treeHrefs\(htmlTree\.nodes\), \.\.\.extractUrls\(treeText\(htmlTree\.nodes\)\)\]\)/,
    "a bare URL that only exists in the rendered text because a pill forced formatted_body must still get a preview card"
  );
});

test("buildEditContent keeps a mention's pill in the new content and its mentions in both places", () => {
  const e = buildEditContent("@Casey fixed", {}, "$t", [{ label: "Casey", userId: GHOST }]);
  const nc = e["m.new_content"] as Record<string, unknown>;
  assert.match(
    nc.formatted_body as string,
    new RegExp(`<a href="https://matrix\\.to/#/${GHOST}">Casey</a>`),
    "m.new_content.formatted_body must carry the pill"
  );
  assert.deepEqual(nc["m.mentions"], { user_ids: [GHOST] });
  assert.deepEqual(e["m.mentions"], { user_ids: [GHOST] });
});

test("editing seeds pendingMentions from the message's m.mentions so an untouched edit keeps its pills", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../features/community/useMatrixEditComposer.ts"),
      "utf8"
    )
  );
  assert.match(src, /pendingMentions\.current\.set\(/, "handleEdit must reseed pendingMentions");
  assert.match(src, /\["m\.mentions"\]/, "handleEdit must read m.mentions to find what to reseed");
});

test("markdown gets an HTML body; the plain body keeps the source (what Element sends)", () => {
  const c = buildMatrixMessage("**bold** and ||secret||", {});
  assert.equal(c.body, "**bold** and ||secret||");
  assert.equal(c.format, "org.matrix.custom.html");
  assert.equal(c.formatted_body, '<strong>bold</strong> and <span data-mx-spoiler>secret</span>');
  assert.equal(c["m.mentions"], undefined);
});

test("emote-only text stays body-only even when wrapped in markdown (the bridge-empty-message guard)", () => {
  const emotes = { OMEGALUL: { url: "https://cdn.7tv.app/x", zeroWidth: false } };
  assert.equal(buildMatrixMessage("OMEGALUL", emotes).formatted_body, undefined);
  assert.equal(buildMatrixMessage("**OMEGALUL**", emotes).formatted_body, undefined, "the HTML would be an <img> alone");
  assert.match(buildMatrixMessage("**OMEGALUL** lol", emotes).formatted_body!, /^<strong><img [^>]*data-mx-emoticon \/><\/strong> lol$/);
});

test("markdown, a pill and a reply compose", () => {
  const c = buildMatrixMessage("*hi* @Casey", {}, REPLY, [{ label: "Casey", userId: GHOST }]);
  assert.match(c.formatted_body!, /<\/mx-reply><em>hi<\/em> <a href="https:\/\/matrix\.to\/#\/@discord_100000000000000001:site\.test">Casey<\/a>$/);
  assert.deepEqual(c["m.mentions"], { user_ids: [GHOST] });
  const bold = buildMatrixMessage("**@Casey**", {}, undefined, [{ label: "Casey", userId: GHOST }]);
  assert.equal(bold.formatted_body, `<strong><a href="https://matrix.to/#/${GHOST}">Casey</a></strong>`);
  assert.deepEqual(bold["m.mentions"], { user_ids: [GHOST] });
  assert.deepEqual(buildMatrixMessage("@Casey **@Casey**", {}, undefined, [{ label: "Casey", userId: GHOST }])["m.mentions"], { user_ids: [GHOST] }, "one id across two runs");
});

test("a multi-line plain message keeps a plain body; a multi-line reply breaks lines with <br>", () => {
  assert.equal(buildMatrixMessage("a\nb", {}).formatted_body, undefined);
  assert.match(buildMatrixMessage("a\nb", {}, REPLY).formatted_body!, /<\/mx-reply>a<br>b$/);
});

test("an edit to markdown carries the formatting in m.new_content", () => {
  const e = buildEditContent("now **bold**", {}, "$orig") as { "m.new_content": { formatted_body?: string }; formatted_body?: string };
  assert.equal(e["m.new_content"].formatted_body, "now <strong>bold</strong>");
  assert.equal(e.formatted_body, "* now <strong>bold</strong>");
});

// Vacuity anchor at the END: the builder really branches on its inputs.
test("a reply and a plain message differ", () => {
  assert.notEqual(buildMatrixMessage("x", {}, REPLY).formatted_body, buildMatrixMessage("x", {}).formatted_body);
});
