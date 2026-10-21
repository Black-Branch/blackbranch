import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
const { PronounMark } = await import("../../components/PronounMark.tsx");

// Pronouns in chat: a small ♂ ♀ ⚲ before the name, the words on
// hover and for screen readers, shown by default, hidden per reader by a chat
// setting — which the OBS source and the /chat window get their own copy of
// through the settings registry's "ov:" scope.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("each of the three draws its own symbol, labelled with the words", () => {
  const marks = ["he/him", "she/her", "they/them"].map((p) => renderToStaticMarkup(createElement(PronounMark, { pronouns: p })));
  for (const [i, p] of ["he/him", "she/her", "they/them"].entries()) {
    const mark = marks[i] ?? "";
    assert.match(mark, new RegExp(`class="chat-pron[^"]*"`));
    assert.match(mark, new RegExp(`title="${p}"`));
    assert.match(mark, new RegExp(`aria-label="${p}"`));
    assert.match(mark, /<svg[^>]*aria-hidden="true"/);
  }
  assert.equal(new Set(marks.map((m) => m.replace(/(title|aria-label)="[^"]*"/g, ""))).size, 3, "three different drawings");
});

test("each has its own soft colour: blue he/him, pink she/her, light grey they/them (grey, not purple, so it reads apart from pink)", () => {
  const colour = (p: string) => /color:(#[0-9a-f]{6})/.exec(renderToStaticMarkup(createElement(PronounMark, { pronouns: p })))?.[1];
  assert.equal(colour("he/him"), "#8ab8f0");
  assert.equal(colour("she/her"), "#f0a8c8");
  assert.equal(colour("they/them"), "#d4d8e0");
});

test("nothing set, or anything outside the three, draws nothing", () => {
  for (const p of [null, undefined, "", "it/its", "any"]) {
    assert.equal(renderToStaticMarkup(createElement(PronounMark, { pronouns: p as string | null })), "", String(p));
  }
});

test("the chat row draws the mark AFTER the name, raised in its corner like the donation clock", () => {
  const row = read("./ChatMessage.tsx");
  assert.match(row, /\{username\}\s*<\/span>[^<]{0,400}<PronounMark pronouns=\{msg\.pronouns\} \/>\s*[\s\S]{0,400}<SponsorClockBadge username=\{msg\.username\} \/>/);
  assert.doesNotMatch(row, /<PronounMark pronouns=\{msg\.pronouns\} \/>\s*\{\/\* Opens the user card/, "the old spot before the name");
  const mark = renderToStaticMarkup(createElement(PronounMark, { pronouns: "she/her" }));
  assert.match(mark, /vertical-align:0\.45em/, "raised like the clock (SponsorClockBadge)");
  assert.match(mark, /margin-left:0\.12em/);
  assert.match(mark, /filter:drop-shadow\(0 1px 1px rgba\(0,0,0,0\.55\)\)/, "the clock's shadow, so it reads over video on the OBS source");
  assert.match(read("../../lib/chatMsg.ts"), /pronouns\?: string \| null;/);
});

test("the OBS source renders chat through the same row, so it gets the mark and the setting", () => {
  const overlay = read("./ChatOverlay.tsx");
  assert.match(overlay, /<ChatMessage\b/);
});

test("hidden by default (a viewer switches them on); the setting hides them with a root class, mirrored before paint — absent key = hidden", () => {
  const reg = read("../../lib/settingsRegistry.ts");
  assert.match(reg, /\n  pronounsOn:\s+false,/);
  assert.match(reg, /pronounsOn: E\(\{ ls: "chatStyle_pronouns", prePaint: true,\s*serialize: ser1, parse: bool1, effect: \(v\) => cls\("chat-pron-off", !\(v as boolean\)\),/);
  assert.match(read("../../lib/settingsMenu.ts"), /s\("pronounsOn"\)/);
  assert.match(read("../../layout.tsx"), /if \(localStorage\.getItem\('chatStyle_pronouns'\) !== '1'\) document\.documentElement\.classList\.add\('chat-pron-off'\);/);
  assert.match(read("../../globals.css"), /\.chat-pron-off \.chat-pron \{ display: none !important; \}/);
});

test("history carries pronouns for restored lines, joined on the row's canonical", () => {
  const src = read("../../api/chat/history/route.ts");
  assert.match(src, /SELECT combined\.\*, pu\.pronouns,\s*CASE WHEN combined\.matrix_id IS NULL\s+AND NOT EXISTS \([\s\S]*?\)\s+THEN pu\.avatar_url END AS avatar_url\s*FROM \(\$\{subqueries\}\) combined\s*LEFT JOIN stream\.users pu ON pu\.id = combined\.canonical_id\s*ORDER BY combined\.created_at DESC, combined\.platform DESC, combined\.id DESC/);
  assert.match(src, /pronouns: r\.pronouns \?\? null,/);
});

// A restored Twitch / YouTube / Kick line must draw the picture its live frame
// drew — history carries the avatar stream-api keeps on the canonical.
test("history carries a platform line's avatar; a native line keeps the Matrix route", () => {
  const src = read("../../api/chat/history/route.ts");
  assert.match(src, /CASE WHEN combined\.matrix_id IS NULL\s+AND NOT EXISTS \([\s\S]*?\)\s+THEN pu\.avatar_url END AS avatar_url/,
    "only a line with no Matrix account, and a person with no other platform, takes the canonical's avatar");
  assert.match(src, /pronouns: r\.pronouns \?\? null,\s*avatarUrl: r\.avatar_url \?\? null,/);
  const row = read("./ChatMessage.tsx");
  assert.match(row, /const pfpSrc = msg\.avatarUrl\s*\?\? \(msg\.matrixId \? `\/api\/avatar\/user\/\$\{encodeURIComponent\(msg\.matrixId\)\}` : null\);/,
    "the row draws the line's own avatar first, then the Matrix route");
});

test("the site's send route asks the one parser for every ! line and answers a misread one", () => {
  const src = read("../../api/chat/send/route.ts");
  assert.match(src, /if \(message\.trimStart\(\)\.startsWith\("!"\)\) \{\s*const r = await askPronounCommand\(\{ text: message, matrixId \}\);/);
  assert.match(src, /if \(r\.usage\) return Response\.json\(\{ error: PRONOUN_USAGE \}, \{ status: 422 \}\);/);
  assert.match(src.slice(-400), /\}\s*$/, "END anchor");
});

test("other people's cards say the words (a phone tap on the name answers what the symbol means)", () => {
  const card = read("../../components/UserCard.tsx");
  assert.match(card, /const pronouns = pronounsSet !== undefined \? pronounsSet : data\?\.pronouns \?\? msg\.pronouns \?\? null;/);
  assert.match(card, /\{pronouns && <span className="text-2xs text-secondary">· \{pronouns\}<\/span>\}/);
  assert.match(read("../../api/user/[id]/route.ts"), /SELECT pronouns FROM stream\.users WHERE id = \$1/);
});
