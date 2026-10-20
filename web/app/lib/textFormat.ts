// Small shared text/time helpers used by both the live chat and the Matrix
// client, so the same formatting lives in one place instead of being repeated
// inline in each component.

/** How many link previews a single message may produce. */
const MAX_PREVIEWS = 3;

/**
 * Trim trailing punctuation that belongs to the sentence, not the URL.
 *
 * Closing parens are conditional. `…/Foo_(disambiguation)` is a real URL, but the
 * `)` in `[label](https://x/y)` is markdown. Only strip a trailing `)` when it is
 * UNBALANCED — i.e. the URL has more `)` than `(`.
 */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    if (last === ")") {
      const opens = (out.match(/\(/g) ?? []).length;
      const closes = (out.match(/\)/g) ?? []).length;
      if (closes <= opens) return out; // balanced → the paren is part of the URL
      out = out.slice(0, -1);
      continue;
    }
    if ("]}.,;:!?'\"…".includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/** The identity two URLs are considered the same under, for dedup only. */
function previewKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";                                     // #m and #anchor are the same page
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");     // trailing slash is not a difference
    return `${u.hostname}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Dedupe URLs for link previews, keeping the first spelling of each.
 *
 * Exact-string `new Set` was not enough: a body carrying both
 * `[Some post](https://bsky.app/…/y)` and the bare `https://bsky.app/…/y` produced
 * `…/y)` AND `…/y` — two distinct strings, so two preview cards, and the paren one
 * resolved to Bluesky's SPA shell (og:site_name "Bluesky", no title or image) =
 * the empty duplicate card.
 */
export function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = trimTrailingPunctuation(raw);
    const key = previewKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length === MAX_PREVIEWS) break;
  }
  return out;
}

/** Up to 3 unique http(s) URLs found in a plain-text string. */
export function extractUrls(text: string): string[] {
  return uniqueUrls(text.match(/https?:\/\/[^\s]+/g) ?? []);
}

/** Truncate to `max` chars with an ellipsis (used for reply previews). */
export function snippet(text: string, max = 20): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Full locale date with year — "Jun 18, 2026" (link timestamps, receipts). */
export function fullDate(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Compact relative age: "just now" / "5m ago" / "3h ago" / "2d ago" / "Jun 18".
 *  Accepts epoch-ms or an ISO string (was duplicated byte-identically in
 *  FeedPanel and ForumView with only the input type differing). */
export function shortWhen(when: number | string | null): string {
  if (when == null || when === "") return "";
  const ts = typeof when === "number" ? when : Date.parse(when);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Discord-style timestamp: "Today at 10:42 AM" / "Yesterday at …" / "Jun 18 …". */
export function formatDiscordTime(d: Date): string {
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
