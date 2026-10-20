// A window's content-fit height change, eased instead of snapped, so every
// refit — higher or lower — gets the same motion. Called from a ResizeObserver
// callback, which runs after layout and before paint: the box is put back at
// the height it had, then transitioned to the one it now has, so no frame
// shows the jump.
//
// A HEIGHT transition is a layout animation (main thread). That is acceptable
// here and nowhere hot: it runs once per section switch, never per frame of a
// gesture, and the panel's gesture/keyboard paths stand it down (the caller
// checks `data-tween` and the returned cancel clears it).
//
// `data-tween` marks the box while it runs so the caller's observer can ignore
// the resizes the tween itself causes. The backstop clears it even when no
// transitionend arrives (reduced motion, a display:none ancestor).

/** `keep`: leave `to` as the box's inline height when done (a top panel sized
 *  to its full height by the user, usePanelPull.ts) instead of handing the
 *  height back to the stylesheet. */
export function tweenHeight(el: HTMLElement, from: number, to: number, keep = false): () => void {
  el.dataset.tween = "";
  el.style.transition = "none";
  el.style.height = `${from}px`;
  void el.offsetHeight; // flush: the start height must be laid out before the transition is armed
  el.style.transition = "height var(--anim-default) var(--anim-ease), translate var(--anim-default) var(--anim-ease)";
  el.style.height = `${to}px`;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    clearTimeout(backstop);
    el.removeEventListener("transitionend", onEnd);
    if (!keep) el.style.height = "";
    el.style.transition = "";
    delete el.dataset.tween;
  };
  const onEnd = (e: TransitionEvent) => { if (e.target === el && e.propertyName === "height") end(); };
  el.addEventListener("transitionend", onEnd);
  const backstop = setTimeout(end, 450);
  return end;
}
