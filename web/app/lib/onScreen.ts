// Is this element actually in front of the person right now? The tab is visible, it sits in no
// inert subtree (the chat column's pager marks every pane but the active one inert), and its box is
// laid out inside the viewport (a hidden tab has no box; a paged-away pane sits off to the side).
// Measured at the moment it is asked — no layout flag stands in for it: "narrow layout" is not
// "the Matrix tab is showing", and treating it so swallowed DMs for the conversation left open in
// the Matrix tab while the person was on Live.
export function elementOnScreen(el: Element | null): boolean {
  if (!el || typeof document === "undefined" || document.visibilityState !== "visible") return false;
  if (el.closest("[inert]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}
