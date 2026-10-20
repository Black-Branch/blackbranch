/**
 * The emote picker's search term, normalised the way the grid should match it.
 *
 * Emote names are chat tokens, so a user never means to type a space in here —
 * but the thing they PASTE very often carries one. The autocomplete inserts
 * `Name ` with a trailing space so the next word starts clean, and copying that
 * straight back out (ctrl+a ctrl+c in the chat bar) must still match.
 *
 * All whitespace goes, not just the ends — a paste picks up a leading space
 * just as easily. Stripping it from the QUERY only is deliberate: a provider
 * name can itself carry stray whitespace (a trailing-space artifact), and a
 * substring match still finds it.
 */
export function emoteQuery(search: string): string {
  return search.replace(/\s+/g, "").toLowerCase();
}
