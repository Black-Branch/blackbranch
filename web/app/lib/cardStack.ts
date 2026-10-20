// The page stack behind the one card.
//
// Pure and node-testable: pages carry only `key` + `title`, and the consumer
// maps `key` to a React node. Keeping the nodes OUT of the stack is what lets
// this be tested without a DOM, and stops a stale closure being retained by a
// page sitting underneath the top one.

export type CardPage = { key: string; title: string };

/** The card's root page — the profile view. Titleless on purpose: the root
 *  leads with its banner and styled name, so a header caption would just
 *  repeat them. Every other page carries one. */
export const ROOT_PAGE: CardPage = { key: "profile", title: "" };

/** Push, unless it is already the top (no-op) or already deeper in the stack
 *  (unwind to it). Both cases arise from re-firing a `bb:open-*` event
 *  while its page is already showing. */
export function pushPage(stack: readonly CardPage[], page: CardPage): CardPage[] {
  const existing = stack.findIndex((p) => p.key === page.key);
  if (existing !== -1) return stack.slice(0, existing + 1);
  return [...stack, page];
}

/** Pop the top page. The root is never removed — the card must never render
 *  empty; closing it is a separate action. */
export function popPage(stack: readonly CardPage[]): CardPage[] {
  return stack.length <= 1 ? [...stack] : stack.slice(0, -1);
}
