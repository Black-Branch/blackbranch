// The video's letterbox is black. Reproduced at 1600×600 on a local install: once the window is
// wider than the 16:9 video fits, the video is centred in a wider area and the space beside it
// was transparent — the page background showing through, which is white on a light background
// theme (186 px each side at that size). The player area now paints black in the two modes that
// centre a 16:9 box (attached and fill); the radio, which fits its own content, is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripCssComments } from "../../lib/testSource.ts";

const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
const rule = (sel: string) => new RegExp(`${sel.replace(/[.]/g, "\\.")}\\s*[,{][^}]*\\}`).exec(css)?.[0] ?? "";

test("attached and fill modes paint the player area black around the 16:9 box", () => {
  for (const sel of [".player-attached .player-area", ".player-fill .player-area"]) {
    const block = css.slice(css.indexOf(sel));
    const body = block.slice(block.indexOf("{"), block.indexOf("}") + 1);
    assert.ok(css.includes(sel), `${sel} is gone`);
    assert.match(css, new RegExp(`${sel.replace(/[.]/g, "\\.")}[^{]*\\{[^}]*background:\\s*(#000|black)`), `${sel} has no black letterbox (${body})`);
  }
});

test("the radio's area is not painted (it fits its own content)", () => {
  assert.doesNotMatch(rule(".player-radio .player-area"), /background/);
  assert.ok(css.length > 10_000, "globals.css was not read — this test read nothing");
});
