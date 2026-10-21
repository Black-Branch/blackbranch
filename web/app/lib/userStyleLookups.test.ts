// The public name-style lookups: /api/users/colors and /api/users/looks
// answer only for the ids asked, the credit overlay's lookup never names an account, and the
// client asks for exactly the ids it draws. The helpers are RUN; the routes (which import through
// the @/ alias node --test cannot resolve) are scanned.
// Run: node --test app/lib/userStyleLookups.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { parseStyleIds, styleLookupLimited } from "./userStyleIds.ts";
import { createUserStyleStore } from "./userStyleStore.ts";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("parseStyleIds: Matrix ids only, deduplicated, at most 200; nothing asked = nothing", () => {
  assert.deepEqual(parseStyleIds(null), []);
  assert.deepEqual(parseStyleIds(""), []);
  assert.deepEqual(parseStyleIds("@casey:site.test, @kit:hs.test:8448,@casey:site.test"), ["@casey:site.test", "@kit:hs.test:8448"]);
  assert.deepEqual(parseStyleIds("casey,@,@x,%,@a b:site.test,@a:site test,' OR 1=1"), []);
  const many = Array.from({ length: 500 }, (_, i) => `@u${i}:site.test`).join(",");
  assert.equal(parseStyleIds(many).length, 200);
});

test("styleLookupLimited: a sliding minute per address", () => {
  const key = "ip:203.0.113.5";
  for (let i = 0; i < 120; i++) assert.equal(styleLookupLimited(key), false);
  assert.equal(styleLookupLimited(key), true);
  assert.equal(styleLookupLimited("ip:203.0.113.6"), false);
});

for (const name of ["colors", "looks"] as const) {
  test(`/api/users/${name}: no ids → {} before any query; the query is bound to the ids; rate-limited`, () => {
    const raw = read("app", "api", "users", name, "route.ts");
    assert.match(raw, /return Response\.json\((data|Object\.fromEntries\([^\n]*\))\);\n\}\n$/, `END of ${name} route not read`);
    const src = stripComments(raw);
    assert.match(src, /const ids = parseStyleIds\(new URL\(req\.url\)\.searchParams\.get\("ids"\)\);\s*if \(ids\.length === 0\) return Response\.json\(\{\}\);\s*if \(styleLookupLimited\(ipKey\(req\)\)\) return new Response\("Too Many Requests", \{ status: 429/);
    assert.match(src, /matrix_id = ANY\(\$1::text\[\]\)/);
    assert.match(src, /deleted_at IS NULL/);
    assert.match(src, /\[ids\]\s*\);/);
    assert.doesNotMatch(src, /let cache|cache = \{/, "the every-account cache is gone");
    assert.ok(src.indexOf("pool.query") > src.indexOf("ids.length === 0"), "no query runs for a request without ids");
  });
}

test("the client store asks once per id, in one batch per tick, chunked under the cap", async () => {
  const urls: string[] = [];
  let run: (() => void) | null = null;
  const store = createUserStyleStore(async <T,>(url: string) => {
    urls.push(url);
    const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");
    return (url.startsWith("/api/users/colors") ? Object.fromEntries(ids.map((id) => [id, "#abcdef"])) : {}) as T;
  }, (fn) => { run = fn; });
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.want(["@a:site.test", "@b:site.test", ""]);
  store.want(["@a:site.test", "not-an-id"]);
  assert.ok(run, "one flush scheduled");
  (run as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(urls.sort(), [
    `/api/users/colors?ids=${encodeURIComponent("@a:site.test,@b:site.test")}`,
    `/api/users/looks?ids=${encodeURIComponent("@a:site.test,@b:site.test")}`,
  ]);
  assert.equal(store.colors()["@b:site.test"], "#abcdef");
  assert.equal(notified, 1);
  urls.length = 0; run = null;
  store.want(["@a:site.test"]);
  assert.equal(run, null, "an id already asked is not asked again");
  store.want(Array.from({ length: 105 }, (_, i) => `@n${i}:site.test`));
  (run as unknown as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(urls.length, 4, "two chunks × two endpoints");
});

test("the client store lets a failed id be asked again", async () => {
  let fail = true;
  let run: (() => void) | null = null;
  const store = createUserStyleStore(async <T,>() => { if (fail) throw new Error("down"); return { "@a:site.test": "#123456" } as T; }, (fn) => { run = fn; });
  store.want(["@a:site.test"]);
  (run as unknown as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  fail = false; run = null;
  store.want(["@a:site.test"]);
  assert.ok(run, "asked again after the failure");
});

test("every component that draws a coloured name asks for its own ids", () => {
  const files: [string[], RegExp][] = [
    [["app", "components", "MatrixMessageRow.tsx"], /useWantUserStyles\(\[senderId\]\);/],
    [["app", "components", "forum", "PostCard.tsx"], /useWantUserStyles\(\[sender\]\);/],
    [["app", "components", "forum", "ThreadView.tsx"], /useWantUserStyles\(\[sender\]\);/],
    [["app", "features", "community", "MemberList.tsx"], /useWantUserStyles\(members\.map\(\(m\) => m\.userId\)\);/],
  ];
  for (const [p, re] of files) assert.match(stripComments(read(...p)), re, p.join("/"));
});
