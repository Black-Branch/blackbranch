// Should an ArrowUp/ArrowDown recall a previous message, or move the caret?
//
// Asking whether the caret sits on the first or last LOGICAL line, by looking
// for "\n", is wrong: a long draft that merely WRAPS has no "\n" at all, so
// every caret position would count as both first and last line — history
// recall would fire from anywhere in the message and preventDefault would stop
// the caret ever moving between wrapped rows.
//
// Deliberately NOT a geometric test. There is no reliable caret rectangle
// inside a <textarea>, and anything derived from scrollHeight or a line-height
// guess breaks on a font change, a zoom, or an emote. Recall from the very ends
// only: it is exact, it survives any wrap width, and it is what every other
// chat client does. The cost is one extra ArrowUp to reach history from the
// middle of a long draft.

export function shouldRecallHistory(
  key: "ArrowUp" | "ArrowDown",
  value: string,
  selectionStart: number,
  selectionEnd: number,
): boolean {
  // A range selection is a shift-arrow or a drag, never a bare caret move.
  if (selectionStart !== selectionEnd) return false;
  return key === "ArrowUp" ? selectionStart === 0 : selectionEnd === value.length;
}
