// Badge images as cacheable URLs, and the badge map's ETag.
//
// site.badges stores each image as a base64 data URI. Returned inline, they make /api/badges
// hundreds of kilobytes per poll for a map that changes a few times a day. Instead each data-URI
// badge is served once at a content-addressed URL the browser caches forever, and the JSON
// carries a strong ETag so an unchanged poll is a bodiless 304.
//
// The type comes from the BYTES, not the data-URI label: a stored image can be a WebP labelled
// `data:image/png`. The extension decides both the served Content-Type and whether
// stillFrame.ts draws a still first frame, so a wrong label would mis-serve or mis-still it.
import { createHash } from "node:crypto";

type Kind = { ext: string; type: string };
const KINDS: Record<string, Kind> = {
  gif: { ext: "gif", type: "image/gif" },
  png: { ext: "png", type: "image/png" },
  jpg: { ext: "jpg", type: "image/jpeg" },
  webp: { ext: "webp", type: "image/webp" },
  avif: { ext: "avif", type: "image/avif" },
  svg: { ext: "svg", type: "image/svg+xml" },
};

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** What the bytes are, by magic number; null when unrecognised. */
function sniff(b: Uint8Array): Kind | null {
  if (b.length >= 4 && ascii(b, 0, 4) === "GIF8") return KINDS.gif!;
  if (b.length >= 4 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return KINDS.png!;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return KINDS.jpg!;
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return KINDS.webp!;
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 12))) return KINDS.avif!;
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return KINDS.svg!;
  return null;
}

/** The bytes and real type of an image data URI, or null if it is not one we can serve. */
export function parseDataImage(dataUrl: string): { bytes: Uint8Array; type: string; ext: string } | null {
  const m = /^data:image\/[\w.+-]+(;[\w=.+-]+)*?(;base64)?,/i.exec(dataUrl);
  if (!m) return null;
  const payload = dataUrl.slice(m[0].length);
  let bytes: Uint8Array;
  try {
    bytes = m[2] ? new Uint8Array(Buffer.from(payload, "base64")) : new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
  const kind = sniff(bytes);
  return kind ? { bytes, type: kind.type, ext: kind.ext } : null;
}

// The hash of a stored image never changes for a given string, and the snapshot hands back the
// same strings for 15 s at a time — so hashing ~650 KB on every poll would be pure waste.
const memo = new Map<string, { hash: string; ext: string } | null>();
function described(dataUrl: string): { hash: string; ext: string } | null {
  const hit = memo.get(dataUrl);
  if (hit !== undefined) return hit;
  const img = parseDataImage(dataUrl);
  const d = img ? { hash: createHash("sha256").update(dataUrl).digest("hex").slice(0, 16), ext: img.ext } : null;
  if (memo.size > 500) memo.clear();
  memo.set(dataUrl, d);
  return d;
}

/** The content address of a stored data-URI image: `<hash>.<ext>`, or null. */
export function badgeImageFile(dataUrl: string): string | null {
  const d = described(dataUrl);
  return d ? `${d.hash}.${d.ext}` : null;
}

/** What a client should load for this badge: our immutable URL for a data URI, anything else
 *  (an https:// or same-origin path, already a URL) passed through untouched. */
export function publicBadgeImageUrl(id: number, imageUrl: string): string {
  if (!imageUrl.startsWith("data:")) return imageUrl;
  const file = badgeImageFile(imageUrl);
  return file ? `/api/badges/image/${id}/${file}` : imageUrl;
}

/** A strong ETag over the exact body sent. */
export function etagFor(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

/** Does an If-None-Match header match this ETag? Weak comparison (RFC 9110 §13.1.2): Cloudflare
 *  turns a strong ETag weak when it compresses the response, so `W/"x"` must match `"x"`. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const want = bare(etag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || bare(t) === want);
}
