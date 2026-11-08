// The part of a name a search matched (ticket #193: the /dm picker and the DM list's "+" show it):
// the typed text found anywhere in the name, ignoring case — the server's own rule
// (lib/dm/resolvePeople.ts). A leading "@" in the query is not part of a name.

/** `text` split around the first case-insensitive match of `query`, or null when it does not match. */
export function matchPart(text: string, query: string): { before: string; match: string; after: string } | null {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return null;
  return { before: text.slice(0, at), match: text.slice(at, at + q.length), after: text.slice(at + q.length) };
}
