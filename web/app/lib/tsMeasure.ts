// The timestamp column's real width. A fixed `ch` table resolved in the MESSAGE
// font puts wrapped lines in the wrong place for any other time font or size,
// so this renders the widest time for the format in the time's OWN styles and
// reads the box.
import type { TsFormat } from "./chatTime.ts";
import { chatFontVar } from "./chatFont.ts";

/** The widest strings a format can produce. Digits are tabular, so one sample
 *  per shape is enough; the 12h and relative forms vary per row, which is why
 *  the column takes the widest (every row then lines up).
 *  @test-only production calls it from measureTsWidth in this same file; exported so tsIndent.test.ts can pin each format's samples */
export function tsWidestSamples(fmt: TsFormat): string[] {
  switch (fmt) {
    case "24": return ["00:00"];
    case "12": return ["12:00 AM", "12:00 PM"];
    case "12s": return ["12:00:00 AM", "12:00:00 PM"];
    case "rel": return ["now", "59m ago", "23h ago", "99d ago"];
    default: return ["00:00:00"]; // "standard" is 24h with seconds in live chat
  }
}

/** px, or null when there is no DOM or nothing laid out (server, tests, a
 *  hidden document) — the caller then keeps the `ch` fallback. */
export function measureTsWidth(fmt: TsFormat): number | null {
  if (typeof document === "undefined" || !document.body) return null;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;"
    + "font-family:var(--chat-font-family, inherit);font-weight:var(--chat-font-weight, 400)";
  const span = document.createElement("span");
  span.style.display = "inline-block";
  span.style.fontSize = chatFontVar("--chat-ts-size");
  span.style.fontFamily = "var(--chat-ts-font, inherit)";
  span.style.fontVariantNumeric = "tabular-nums";
  host.appendChild(span);
  document.body.appendChild(host);
  let w = 0;
  for (const s of tsWidestSamples(fmt)) {
    span.textContent = s;
    w = Math.max(w, span.getBoundingClientRect().width);
  }
  host.remove();
  return w > 0 ? Math.ceil(w) : null;
}
