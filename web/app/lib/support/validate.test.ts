import { test } from "node:test";
import assert from "node:assert/strict";
import { clampTicket, clampReport, transcriptRole } from "./validate.ts";

test("tickets: kind whitelist, body required, caps applied", () => {
  assert.equal(clampTicket(null), null);
  assert.equal(clampTicket({ kind: "user_report", body: "x" }), null, "reports are NOT tickets");
  assert.equal(clampTicket({ kind: "bug", body: "   " }), null, "whitespace body is no body");
  const t = clampTicket({ kind: "bug", body: "b".repeat(3000) });
  assert.equal(t?.body.length, 2000);
});

test("tickets: transcript is optional, shape-checked, and truncated", () => {
  assert.equal(clampTicket({ kind: "other", body: "x" })?.transcript, null);
  assert.equal(clampTicket({ kind: "other", body: "x", transcript: "junk" })?.transcript, null);
  const many = Array.from({ length: 60 }, (_, i) => ({ role: "user", text: `m${i}` + "y".repeat(600) }));
  const t = clampTicket({ kind: "bug", body: "x", transcript: [...many, { role: "hacker", text: "drop" }] });
  assert.equal(t?.transcript?.length, 40, "keeps the LAST 40, drops malformed rows");
  assert.ok(t!.transcript!.every((m) => m.text.length <= 500));
});

test("the desk's role is 'bot'; the retired 'gadget' role is dropped like any unknown one", () => {
  const t = clampTicket({ kind: "bug", body: "x", transcript: [{ role: "gadget", text: "hi" }, { role: "bot", text: "yo" }, { role: "user", text: "u" }] });
  assert.deepEqual(t?.transcript?.map((m) => m.role), ["bot", "user"]);
  assert.equal(transcriptRole("gadget"), null);
  assert.equal(transcriptRole("assistant"), null);
});

test("reports: both fields required, caps applied", () => {
  assert.equal(clampReport({ username: "x", reason: "" }), null);
  assert.equal(clampReport({ username: "", reason: "y" }), null);
  const r = clampReport({ username: " Trouble ", reason: "r".repeat(900) });
  assert.equal(r?.username, "Trouble");
  assert.equal(r?.reason.length, 500);
});
