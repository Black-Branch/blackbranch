import "../../lib/testTsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "../../lib/testSource.ts";
const { BoardsWidget } = await import("./widgets/BoardsWidget.tsx");
const { FACE_IDS, WINDOW_IDS } = await import("../../lib/boardFaces.ts");

const person = (i: number, value: number) => ({ key: `@p${i}:x`, rank: i, name: `person${i}`, color: "#abcdef", style: null, avatarUrl: null, value });
const empty = () => Object.fromEntries(FACE_IDS.map((f) => [f, Object.fromEntries(WINDOW_IDS.map((w) => [w, []]))])) as never;
const boards = () => {
  const b = empty() as Record<string, Record<string, unknown[]>>;
  b.credit!.week = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => person(i, 100 - i));
  b.credit!.stream = [person(1, 7)];
  b.messages!.week = [{ key: "twitch:9", rank: 1, name: "kate", color: "#ff00aa", style: null, avatarUrl: null, value: 41, text: "hello Kappa", emotes: { Kappa: "https://e/kappa.png" } }];
  b.emotes!.week = [{ key: "KEKW", rank: 1, name: "KEKW", color: null, style: null, avatarUrl: null, value: 412, emoteUrl: "https://e/kekw.png" }];
  return b as never;
};
const html = (p: Partial<Parameters<typeof BoardsWidget>[0]>) =>
  renderToStaticMarkup(createElement(BoardsWidget, { boards: boards(), loading: false, live: false, signedIn: false, ...p }));

test("the default face is the vote score (Karma on a fresh install), the offline default window is Week: TEN rows, rank · name · value, names in their colour", () => {
  const h = html({});
  assert.equal((h.match(/<li /g) ?? []).length, 10);
  assert.match(h, /aria-pressed="true"[^>]*>Karma</);
  assert.match(h, /aria-pressed="true"[^>]*>Week</);
  for (let i = 1; i <= 10; i++) assert.match(h, new RegExp(`>${i}<[\\s\\S]*?person${i}[\\s\\S]*?\\+${100 - i}<`));
  assert.match(h, /color:#abcdef/);
  assert.doesNotMatch(h, /role="tab"/);
  assert.doesNotMatch(h, />You</);
});

test("live → the Stream pill is the default; its one row shows", () => {
  const h = html({ live: true });
  assert.match(h, /aria-pressed="true"[^>]*>Stream</);
  assert.match(h, /person1[\s\S]*?\+7</);
  assert.doesNotMatch(h, /person2/);
});

test("every face this install offers is a chip, in the faces' order — the AI-score faces only with the plugin that scores", () => {
  const h = html({});
  // This tree's site plugin declares both scores (karma, intelligence); the public build has none
  // (TEST_NO_OWNER=1, or no owner folder) — boardsWidget.public.render.test.ts mounts that one.
  const owner = process.env.TEST_NO_OWNER !== "1" && fs.existsSync(path.join(process.cwd(), "app/(owner)/plugin.ts"));
  const ai = ["Wholesome", "Toxic", "Big brain", "Small brain"];
  const labels = ["Earned points", "Karma", "Karma / 100", "Streams", ...(owner ? ai : []), "Top messages", "Top emotes"];
  let at = -1;
  for (const l of labels) { const i = h.indexOf(`>${l}</button>`); assert.ok(i > at, `${l} in order`); at = i; }
  assert.equal((h.match(/<\/button>/g) ?? []).length, labels.length + 4, "the faces plus the four window pills, nothing else");
});

test("empty face → Nothing yet; no boards → Loading… / Couldn't load", () => {
  assert.match(html({ boards: empty() }), />Nothing yet</);
  assert.match(html({ boards: null, loading: true }), /Loading…/);
  assert.match(html({ boards: null, loading: false }), /Couldn&#x27;t load right now\./);
});

test("a cold window (null list, the boards still warming) says Loading…, not Nothing yet; an avatar renders through its URL", () => {
  const b = boards() as Record<string, Record<string, unknown>>;
  b.credit!.week = null;
  assert.match(html({ boards: b as never }), /Loading…/);
  assert.doesNotMatch(html({ boards: b as never }), /Nothing yet/);
  const c = boards() as Record<string, Record<string, unknown[]>>;
  c.credit!.week = [{ ...person(1, 50), avatarUrl: "/api/avatar/user/%40p1%3Ax" }];
  assert.match(html({ boards: c as never }), /<img src="\/api\/avatar\/user\/%40p1%3Ax" alt=""/);
});

test("the face chips WRAP so every face is reachable (no sideways scroll), and every board's avatars are preloaded once so switching faces never reloads", () => {
  const h = html({});
  assert.match(h, /class="flex flex-wrap gap-1\.5"/);
  assert.doesNotMatch(h, /overflow-x-auto no-scrollbar/);
  assert.doesNotMatch(h, /loading="lazy"/);
  assert.match(src, /new Image\(\)\.src = url/, "each avatar / emote URL across every face × window is warmed in the browser cache on mount");
});

test("a Top messages row shows the WHOLE message, wrapped under the name — never cut off", () => {
  assert.match(src, /<span className="text-secondary whitespace-pre-wrap break-words">\{renderText\(r\.text \?\? "", EMPTY_EMOTES, r\.emotes\)\}<\/span>/);
});

test("a row with no picture draws the site's letter circle (avatarBg + initial), never a blank dot", () => {
  const h = html({});
  assert.match(h, /style="background-color:hsl\([^"]*"[^>]*>p<\/span>/, "person1 → 'p' on its hashed colour");
});

test("the widget owns its header: the face name is the h2 and the window pills sit beside it", () => {
  const h = html({});
  assert.match(h, /<h2[^>]*>Karma<\/h2>/);
  assert.match(h, /<h2[\s\S]*?<\/h2>[\s\S]*?>Stream<[\s\S]*?>Week<[\s\S]*?>Month<[\s\S]*?>All</);
});

// The messages and emotes faces, the You row and the remembered face are
// reached by a click or a fetch, which a static render cannot do — pinned by
// source scan.
const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/features/home/widgets/BoardsWidget.tsx"), "utf8"));

test("messages rows render the text through renderText with the message's own emote map; emote rows draw the picture; the face is remembered per device; the rank is asked from /api/home/rank", () => {
  assert.match(src, /renderText\(r\.text \?\? "", EMPTY_EMOTES, r\.emotes\)/);
  assert.match(src, /<img src=\{r\.emoteUrl\}[^>]*alt=\{r\.name\}/);
  assert.match(src, /useLocalStorageString\("home_board_face"\)/);
  assert.match(src, /getJson<Rank \| null>\(`\/api\/home\/rank\?face=\$\{face\}&window=\$\{win\}`\)/);
  assert.match(src, /usernameStyleCSS\(r\.style, r\.color\)/);
  assert.match(src, /windowsFor\(face\)\.includes\(wanted\) \? wanted : windowsFor\(face\)\[0\]/, "a Stream pick on the Streams face falls to its first offered window (Week)");
  assert.match(src, /rank\.rank <= 10/, "in the ten → highlight, no eleventh row");
  assert.match(src, /rank\.rank > 10/, "beyond the ten → the You row");
  assert.match(src, /\}\s*$/);
});
