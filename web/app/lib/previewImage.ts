// A link preview's image URL, as an <img> may load it. The og:image (and a post card's avatar)
// comes from an arbitrary page: a RELATIVE one — `/api/…`, `..\api\…` — would resolve against
// THIS site and send a same-origin GET with the viewer's cookies. Only an absolute http(s) URL
// passes; protocol-relative, data:, javascript: and anything unparseable are dropped.

/** `raw` when it is an absolute http(s) URL, else null. */
export function previewImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}
