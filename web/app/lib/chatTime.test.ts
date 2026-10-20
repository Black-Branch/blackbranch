// Run: node --test app/lib/chatTime.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatChatTime, tsIndentWidth, TS_FORMATS } from "./chatTime.ts";

const d = new Date(2026, 8, 28, 15, 4, 27);      // local 15:04:27
const morning = new Date(2026, 8, 28, 9, 5, 7);
const now = new Date(2026, 8, 28, 15, 6, 0);

test("explicit formats are locale-independent", () => {
  assert.equal(formatChatTime(d, "24s", "live", now), "15:04:27");
  assert.equal(formatChatTime(d, "24", "live", now), "15:04");
  assert.equal(formatChatTime(d, "12", "live", now), "3:04 PM");
  assert.equal(formatChatTime(d, "12s", "live", now), "3:04:27 PM");
  assert.equal(formatChatTime(morning, "24s", "live", now), "09:05:07");
  assert.equal(formatChatTime(morning, "12", "live", now), "9:05 AM");
  assert.equal(formatChatTime(new Date(2026, 8, 28, 0, 1, 0), "12", "live", now), "12:01 AM");
});

test("standard = each place's look before this setting existed", () => {
  assert.equal(formatChatTime(d, "standard", "live", now), "15:04:27");
  assert.match(formatChatTime(d, "standard", "community-header", now), /^Today at /);
  // hover follows the header's (locale) time, NOT forced 24h
  const hover = formatChatTime(d, "standard", "community-hover", now);
  assert.equal(hover, d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
});

test("community header keeps its day prefix with an explicit format", () => {
  assert.equal(formatChatTime(d, "24", "community-header", now), "Today at 15:04");
  const yest = new Date(2026, 8, 27, 15, 4, 27);
  assert.equal(formatChatTime(yest, "12", "community-header", now), "Yesterday at 3:04 PM");
  assert.equal(formatChatTime(d, "24", "community-hover", now), "15:04");
});

test("relative", () => {
  assert.equal(formatChatTime(d, "rel", "live", now), "1m ago");
  assert.equal(formatChatTime(new Date(now.getTime() - 20_000), "rel", "live", now), "now");
});

test("indent widths: 24s keeps today's value; every format has one", () => {
  assert.equal(tsIndentWidth("24s"), "calc(6.5ch + 0.25rem)");
  assert.equal(tsIndentWidth("standard"), "calc(6.5ch + 0.25rem)");
  for (const f of TS_FORMATS) assert.match(tsIndentWidth(f), /^calc\([\d.]+ch \+ 0\.25rem\)$/);
});
