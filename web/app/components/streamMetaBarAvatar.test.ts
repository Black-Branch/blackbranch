// The meta bar's fallback avatar (no streamer picture): the initials of THIS install's streamer —
// or of the site when no streamer name is set — never two letters written into the component,
// which every install showed whatever its streamer was called.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initials } from "../lib/streamView.ts";

const src = readFileSync(new URL("./StreamMetaBar.tsx", import.meta.url), "utf8");

test("the fallback circle shows the streamer's initials, else the site's", () => {
  // The circle after the streamer-picture branch: its only child is the initials expression.
  const fallback = src.match(/onError=\{\(\) => setPfpFailed\(true\)\} \/>\n {10}\) : \(\n {12}<div [^>]*>\n {14}([^\n]*)\n {12}<\/div>/)?.[1];
  assert.equal(fallback, "{initials(streamerName || siteName())}");
  assert.equal(initials("Casey Rivers"), "CR");
  assert.equal(initials("Example Stream"), "ES");
  assert.match(src, /\nexport default|\nexport function/, "vacuity: the component file was read");
});
