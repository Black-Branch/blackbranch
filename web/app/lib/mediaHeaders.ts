// Shared hardening for everything that serves Matrix media, whose Content-Type is chosen by whoever
// uploaded it — and for a federated upload, by their homeserver. A type that a browser renders as a
// document (HTML, any XML, SVG, a comma list it reads its own way, a multipart stream…) opened from
// our origin would run script as the viewer. So the type is decided by an ALLOWLIST, not a list of
// known-bad types: raster images, audio, video and plain text are reflected; everything else is
// served as application/octet-stream with Content-Disposition: attachment.
//
// Two further layers so a miss in one is still contained:
//   • nosniff, so a browser never upgrades an inert type back into a document;
//   • a sandbox CSP on the response. For it to reach the browser, nothing may set the site's CSP on
//     these paths first — Next keeps the first Content-Security-Policy it sees — so proxy.ts sends
//     this one for MEDIA_PROXY_PREFIX and next.config.ts's file rule leaves the prefix out.
// A CSP on the response is ignored for <img>/<video> loads, so inline display is unaffected.

/** The Matrix media proxy's path. proxy.ts and next.config.ts must not give it the site's CSP. */
export const MEDIA_PROXY_PREFIX = "/api/matrix/media/";

// Raster image types an image may be served as (svg is a document: it can carry script).
const SAFE_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "image/apng", "image/bmp", "image/x-icon",
]);

// Types with no active content that a browser shows as they are. application/pdf is not one: a
// browser's PDF viewer runs the document's own scripts, so a PDF is a download.
const INERT_TYPES = new Set(["text/plain"]);

// RFC 9110 token characters, then optional `; name=value` parameters (value a token or a quoted
// string). Anything else — a comma list, a second type, a stray character — is not one media type.
const TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]+";
const MEDIA_TYPE = new RegExp(
  `^\\s*(${TOKEN})/(${TOKEN})\\s*(?:;\\s*${TOKEN}\\s*=\\s*(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*")\\s*)*;?\\s*$`,
  "i",
);

/** The `type/subtype` of a single well-formed media type, lower-cased; null for anything else. */
function essence(ct?: string | null): string | null {
  const m = MEDIA_TYPE.exec(ct ?? "");
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The ONE allowlist: the media type to serve or label `ct` as, or null when it is anything that
 *  is not plainly an image, audio, video or plain text. A `+xml` subtype is a document in every
 *  browser whatever its top-level type, so it never passes. */
function safeMediaType(ct?: string | null): string | null {
  const t = essence(ct);
  if (!t) return null;
  if (SAFE_IMAGE_TYPES.has(t) || INERT_TYPES.has(t)) return t;
  const [top, sub = ""] = t.split("/");
  if ((top === "video" || top === "audio") && !sub.includes("xml")) return t;
  return null;
}

/** General media proxy: the upstream type when the allowlist accepts it, else a download type.
 *  `fallback` is used only when there is no type at all, and is itself held to the allowlist. */
export function proxiedContentType(upstream?: string | null, fallback = "application/octet-stream"): string {
  if (!(upstream ?? "").trim()) return safeMediaType(fallback) ?? "application/octet-stream";
  return safeMediaType(upstream) ?? "application/octet-stream";
}

/** The Content-Disposition to send with `contentType`. Anything not on the allowlist is an
 *  attachment; the upstream's own header is kept when it already says attachment (it carries the
 *  file name). An allowlisted type is served inline, as before. */
export function mediaDisposition(contentType: string, upstream?: string | null): string | null {
  const keep = upstream && /^\s*attachment\s*(;|$)/i.test(upstream) ? upstream.trim() : null;
  if (safeMediaType(contentType)) return keep;
  return keep ?? "attachment";
}

/** The type for a decrypted attachment's blob: URL (same-origin, so the same rule applies). */
export function blobMediaType(mimetype?: unknown): string {
  return (typeof mimetype === "string" && safeMediaType(mimetype)) || "application/octet-stream";
}

/** Image-only routes (avatars): only a known raster image type may be reflected;
 *  anything else becomes a (broken) image rather than a potential document. */
export function imageContentType(upstream?: string | null, fallback = "image/png"): string {
  const t = essence(upstream);
  return t && SAFE_IMAGE_TYPES.has(t) ? t : fallback;
}

/** The policy every media response carries. No script runs in it at all: `sandbox` without
 *  allow-scripts, and `default-src 'none'` covers script-src too. Nothing loads but the file
 *  itself — a picture or a video opened on its own is shown in a document of its own that loads
 *  the file again as an <img> or <video>; under `default-src 'none'` alone Chrome blocks that load.
 *  allow-same-origin keeps the document's origin for that same load: with an opaque origin Chrome
 *  refuses the video against this route's Access-Control-Allow-Origin, and a sandbox that cannot
 *  run script gains nothing from the opaque origin. Inline style is the browser's own layout for
 *  that document (a picture centred on a dark page); it runs nothing. */
export const MEDIA_CSP = "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/** Attach to every media-proxy response: stop MIME sniffing and sandbox the body, with nothing
 *  allowed to load, so it is inert if opened as a top-level document. Inert for <img> loads. */
export const MEDIA_SAFETY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": MEDIA_CSP,
};
