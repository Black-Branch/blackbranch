// The help desk's load-time greeting lands where the person can use it (#170).
//
// The defect: the greeting (first visit, or the link-account reminder) renders in the live chat
// column, between the messages and the composer. On a phone whose pager shows another pane (Home,
// Matrix, a content tab) that column is off screen, so the greeting asked a question nobody could
// see or answer. When the opener greets, the live pane is brought on screen. A computer shows the
// live column beside everything else, so nothing moves there.
//
// Run: node --test app/features/chat/support/greetingPane.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paneForGreeting } from "./greetingPane.ts";
import { stripComments } from "../../../lib/testSource.ts";

test("a phone showing another pane is moved to the live chat when the greeting opens", () => {
  for (const pane of ["home", "matrix", "news", "forums"]) assert.equal(paneForGreeting(true, pane), "live", pane);
});

test("original path: a phone already on the live chat, or a computer, stays where it is", () => {
  assert.equal(paneForGreeting(true, "live"), null);
  for (const pane of ["live", "matrix", "home"]) assert.equal(paneForGreeting(false, pane), null, pane);
});

test("wiring: the opener asks for the pane once, and the sidebar commits it through selectPane", () => {
  const src = stripComments(readFileSync(new URL("../ChatSidebar.tsx", import.meta.url), "utf8"));
  const opener = src.indexOf('getJson<{ link_account?: { show: boolean; offerNever: boolean } }>("/api/nudges")');
  const ask = src.indexOf("setGreetPending(true);", opener);
  assert.ok(opener > 0 && ask > opener, "the load-time opener does not ask for the live pane when it greets");
  assert.match(src, /if \(greetPending\) \{\n\s*setGreetPending\(false\);\n\s*const pane = paneForGreeting\(pagerOn, activePane\);\n\s*if \(pane\) selectPane\(pane\);\n\s*\}/,
    "the request is consumed once (retry: a later reload asks again) and goes through the ONE commit path");
  assert.match(src.trimEnd(), /\n\}$/, "END anchor");
});
