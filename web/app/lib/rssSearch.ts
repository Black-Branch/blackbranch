// The RSS search term → SQL LIKE pattern decision (support ticket #7).
//
// Pure and dependency-free so it can be unit-tested directly: rssServer.ts
// imports the pg pool, and the test runner (`node --test`) resolves neither the
// `@/` alias nor a database.

/**
 * Shortest term we will actually run a query for.
 *
 * NOT arbitrary. A trigram index stores 3-character fragments, so Postgres
 * cannot use one for a pattern with no whole trigram in it — a 1-character `q`
 * would seq-scan every stored item, on a PUBLIC endpoint, on every keystroke.
 * It would also match almost everything, so the scan buys nothing either.
 *
 * @test-only read only by searchPattern below and by rssSearch.test.ts, which
 * pins it at 2. The number is a fact about the trigram index, not a taste
 * setting, so a test asserting the literal value earns its keep: raising it to
 * 3 would silently stop the panel filtering on two-letter terms, and lowering
 * it to 1 puts a seq-scan on a public endpoint behind every keystroke.
 */
export const MIN_QUERY_LEN = 2;

/**
 * The `ILIKE` pattern for a search term, or `null` for "do not filter".
 *
 * Returning null for a short term means the panel keeps showing the newest items
 * while someone types the first letter, rather than flashing an empty list.
 *
 * LIKE metacharacters are escaped, so searching for "100%" finds the text
 * "100%" instead of matching everything that starts "100" — and a lone "%" is a
 * literal percent sign, not "return the whole table". The escape character is a
 * backslash, which the SQL must declare with `ESCAPE '\'` for the pattern to be
 * read the same way; the two halves only work as a pair.
 */
export function searchPattern(q: string): string | null {
  const term = q.trim();
  if (term.length < MIN_QUERY_LEN) return null;
  return `%${term.replace(/[%_\\]/g, "\\$&")}%`;
}
