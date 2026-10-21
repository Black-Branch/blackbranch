// Contract 7: a provider on → the site's own donate page; else site.donateUrl (https only); else no
// button. Also pins the server half's wiring: the stream page and /donate read the same rule.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { donateTarget, httpsLink } from "./donateTarget.ts";

const OWN_DONATE_PAGE = "/donate";

test("a provider on: the site's own tip page, whatever the outside link says", () => {
  assert.equal(donateTarget({ providerOn: true, donateUrl: "https://ko-fi.com/casey" }), OWN_DONATE_PAGE);
  assert.equal(donateTarget({ providerOn: true, donateUrl: null }), OWN_DONATE_PAGE);
});

test("no provider: the outside link, https only", () => {
  assert.equal(donateTarget({ providerOn: false, donateUrl: "https://ko-fi.com/casey" }), "https://ko-fi.com/casey");
  assert.equal(donateTarget({ providerOn: false, donateUrl: "  https://paypal.me/casey  " }), "https://paypal.me/casey");
  for (const bad of ["http://ko-fi.com/casey", "javascript:alert(1)", "ko-fi.com/casey", "", "   "]) {
    assert.equal(donateTarget({ providerOn: false, donateUrl: bad }), null, bad);
  }
});

test("no provider and no link: no Donate button at all (null), never the dead-end page", () => {
  assert.equal(donateTarget({ providerOn: false, donateUrl: null }), null);
  assert.equal(donateTarget({ providerOn: false, donateUrl: undefined }), null);
  assert.equal(httpsLink(null), null);
});

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("wiring: the stream page hands StreamView the rule's answer, not the raw DONATE_URL env", () => {
  const page = src("../(main)/page.tsx");
  assert.match(page, /donateUrl=\{donateTarget\(/);
  assert.doesNotMatch(page, /process\.env\.DONATE_URL/);
  assert.doesNotMatch(page, /streamlabs\.com/, "no third-party tip link in the fallback");
  const meta = src("../components/StreamMetaBar.tsx");
  assert.match(meta, /\{donateUrl !== null && <button/, "the Donate button renders only when there is somewhere to go");
});

test("wiring: /donate with no provider sends a visitor to the outside link instead of a dead end", () => {
  const page = src("../donate/page.tsx");
  assert.match(page, /redirect\(outside\)/);
  // Vacuity anchor at the END of the file: the scan read the whole page.
  assert.match(page.trimEnd(), /\}$/);
});
