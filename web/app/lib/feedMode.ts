// The under-video space (the bottom dock) fills whatever the video leaves in
// the column. The video is sized by the chat resize (the dominant control)
// exactly as before; the leftover — measured live, minus the dock's tab row
// (dockState.contentAvail) — picks the News tab's render style: none when
// there's no room (auto-hide), a horizontal ticker when it's short, a
// thumbnail list when it's tall.
export type FeedView = "hidden" | "ticker" | "list";

const FEED_HIDE_BELOW = 30; // leftover under this → auto-hide (no room)
const FEED_TICKER_MAX = 108; // leftover under this → ticker, otherwise list

export function viewForHeight(availPx: number): FeedView {
  if (availPx < FEED_HIDE_BELOW) return "hidden";
  return availPx < FEED_TICKER_MAX ? "ticker" : "list";
}
