// Pure capacity/visibility resolver for the Matrix UnifiedLayout. The open room
// (timeline) is the anchor; directory (left) + the right slot (thread / threads-
// list / members) are toggles that the panel's *own* width gates:
//   mode 1: exactly one view at a time (mobile-Discord style)
//   mode 2/3: timeline always shows; side panels slide in alongside it
// Kept side-effect-free so the layout decision is testable in isolation.

export interface VisibilityInput {
  mode: number;
  hasSelected: boolean;
  directoryOpen: boolean;
  membersOpen: boolean;
  threadsListOpen: boolean;
  hasThreadEvent: boolean;
}

export interface Visibility {
  showDirectory: boolean;
  showTimeline: boolean;
  showMembers: boolean;
  showThread: boolean;
  showThreadsList: boolean;
}

export function resolveVisibility({
  mode,
  hasSelected,
  directoryOpen,
  membersOpen,
  threadsListOpen,
  hasThreadEvent,
}: VisibilityInput): Visibility {
  let showDirectory: boolean;
  let showTimeline: boolean;
  let showMembers: boolean;
  let showThread: boolean;
  let showThreadsList: boolean;
  if (mode === 1) {
    // Single-panel precedence:
    // directory (also when nothing is open) → thread → threads-list → members → timeline.
    showDirectory = !hasSelected || directoryOpen;
    showThread = !showDirectory && hasThreadEvent;
    showThreadsList = !showDirectory && !showThread && threadsListOpen && hasSelected;
    showMembers = !showDirectory && !showThread && !showThreadsList && membersOpen && hasSelected;
    showTimeline = !showDirectory && !showThread && !showThreadsList && !showMembers && hasSelected;
  } else {
    showTimeline = true;
    showDirectory = directoryOpen;
    showThread = hasThreadEvent;
    showThreadsList = threadsListOpen && hasSelected && !showThread;
    showMembers = membersOpen && hasSelected && !showThread && !showThreadsList;
  }
  return { showDirectory, showTimeline, showMembers, showThread, showThreadsList };
}

// ─── Inner-pager derivations ──────────────────────────────────────────────────
//
// The Matrix pane nests its own snap scroller (mode 1 + touch only). In mode 1
// the three single-panel views become a nested horizontal snap row, so the
// continuous journey chat → matrix home → channel → user list → news is one
// gesture.
//
// These are DERIVATIVES of the resolver above, never a second authority.
// The open/close FLAGS stay the source of truth: a settle writes them through
// `onCommit`, and every non-swipe path (openRoom's mode-1 collapse, Timeline's
// onBack, toggleMembers) keeps writing them — the pager's external-sync effect
// converts those writes into scroll positions.
// They live here, beside `resolveVisibility`, because they read its output and
// because UnifiedLayout's many hooks make them untestable in place.

export type MatrixPaneKey = "directory" | "timeline" | "members";

/** The inner row's ordered pane keys. With no room selected there is nothing
 *  for a timeline or a member list to be ABOUT (the resolver says the same:
 *  `showTimeline`/`showMembers` both need `hasSelected`), so the row is a
 *  single pane and the outer pager owns every swipe. */
export function matrixPaneKeys(hasSelected: boolean): MatrixPaneKey[] {
  return hasSelected ? ["directory", "timeline", "members"] : ["directory"];
}

/** Which pane the committed flags currently put under the viewport — the
 *  pager's `activeKey`, and so also its at-rest `inert` reference.
 *  In mode 1 the resolver already makes these mutually exclusive (its
 *  "exactly ONE panel" rule), so the ordering here is what makes the function
 *  total, not a precedence anyone can observe. */
export function matrixActivePane(vis: Visibility): MatrixPaneKey {
  if (vis.showDirectory) return "directory";
  if (vis.showMembers) return "members";
  return "timeline";
}

/** Whether the inner pager owns motion. Mode 1 only (modes 2/3 show panels
 *  side by side — there is nothing to swipe between), it YIELDS to the
 *  thread region (a single thread or the threads list takes the whole panel
 *  in an overlay swap, outside the pager), AND it is "mode 1 + touch only":
 *  `coarse` gates it to a coarse (touch) pointer. Without that gate, a
 *  desktop unsplit chat panel under 680px (mode 1 on a FINE pointer) would get
 *  a live, invisible snap row: trackpad two-finger horizontal pans and
 *  shift+wheel would page the Matrix panes and commit the directory/members
 *  flags on nothing more than a diagonal scroll. Kept as a
 *  parameter (not read from inside this pure module) so the resolver stays
 *  side-effect-free and testable in isolation; the caller supplies it from
 *  the house `Q_POINTER_COARSE` query (deviceQueries.ts). Buttons/flags are
 *  unaffected — that path stays open on every pointer type. */
export function matrixPagerEnabled(mode: number, coarse: boolean, vis: Visibility): boolean {
  return mode === 1 && coarse && !vis.showThread && !vis.showThreadsList;
}
