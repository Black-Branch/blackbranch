// Which of the player's two bars are on screen, and in what form.
//
// One pure function with one place to read the rules, so "the keyboard must
// never unmount the bottom bar" is an assertion (barVisibility.test.ts) rather
// than a comment nobody re-reads. A single flag feeding BOTH bars would take
// the donate pills off screen with the title whenever the phone keyboard
// opened.
//
// `keyboardOpen` is NOT an input. The keyboard does not touch bar FLOW at all.
// On phones the whole video column translates up by the ramp distance — the
// top token PLUS the page padding and frame border above it (`--chrome-top-h +
// --panel-gap + --frame-width`, ~50px at defaults; see globals.css's phone
// block), not the token alone — while the top bar goes inert via `Bar
// occluded` (StreamView); the bottom bar stays exactly where it is and rises
// WITH the column, which is the revenue rule stated as a distance rather than
// a separate flag. ≥768px devices with a soft keyboard keep BOTH bars — they
// have the room, and `Q_NARROW`/`Q_DEVICE_MOBILE` already disagree in the
// 768–1023px band by design (deviceQueries.ts). A transform is not a
// distance this function knows about; it is invisible from here on purpose.
//
// The two bars are NOT symmetric and shouldn't be made so:
//   • top bar    — wordmark, source switcher, LIVE, the marathon timer.
//                  Informational. Safe to hide; this is where reclaimed space
//                  actually comes from.
//   • bottom bar — the things a viewer might act on, and money is one of them.
//                  Hiding a donate button costs revenue, so it survives every
//                  state except explicit mobile compact — the viewer asked for
//                  that one, and the chat's TAB BAR (its far-left toggle) is
//                  how they undo it. No floating pill does that job: the tab
//                  bar stays on screen in mobile compact, and a pill would
//                  land on top of it.

export type BarInputs = {
  narrow: boolean;
  /** Explicit "compact" toggle: desktop auto-hide, mobile full hide. */
  barsHidden: boolean;
  theatre: boolean;
};

// One distance per bar. "Hidden" is the bar's whole height, overlay is the
// desktop hover-reveal, and the meta bar has no separate collapsed row.
export type BarVisibility = {
  /** Desktop only: both bars leave the flow and reveal on pointer proximity / focus. */
  overlay: boolean;
  /** The top bar's distance is its whole height (mobile compact only — see header). */
  topHidden: boolean;
  /** The bottom bar's distance (mobile compact only). */
  bottomHidden: boolean;
  /** Both bars sit in normal flow and hug the video (drives the video sizing). */
  barsInFlow: boolean;
};

export function barVisibility({ narrow, barsHidden, theatre }: BarInputs): BarVisibility {
  return {
    // Desktop only: phones have no hover, so a proximity reveal is unreachable.
    overlay: !narrow && (theatre || barsHidden),
    topHidden: narrow && barsHidden,
    bottomHidden: narrow && barsHidden,
    barsInFlow: !barsHidden,
  };
}
