// Decoding the handful of entities scraped page text carries (a YouTube title, an og:title).

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#039": "'" };

/**
 * `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#39;` → their characters, in ONE pass: a chain of
 * replaces that does `&amp;` first decodes twice, so a title that really says `&lt;` (sent as
 * `&amp;lt;`) would come out as `<`. Anything else is left as written.
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#0?39);/g, (m, name: string) => ENTITIES[name] ?? m);
}
