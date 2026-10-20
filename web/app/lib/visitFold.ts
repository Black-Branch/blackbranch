// The fold follows the stream state on every visit: offline → player folded,
// chat folded, Home open; live → both unfolded.
// StreamView seeds the FIRST PAINT from the server's `isLive` when this device
// has nothing stored (so a stranger's first frame is already the right shape),
// and runs this rule once in a layout effect for what IS stored — before
// paint, so a returning viewer never sees last visit's shape collapse into
// this one. Toggles made during a visit stand until the stream state changes
// (the live edge in StreamView).
//
// Pure. StreamView applies the answer: `player` by writing the fold key,
// `chat` through usePanelResize's applyMode, `openHome` by writing the dock's
// open tab and dispatching OPEN_HOME_EVENT for the phone pane (ChatSidebar
// owns that state and listens).
//
// Theatre and full-screen community are DELIBERATE picks and stand entirely on
// desktop: the dock is not mounted in either (StreamView's fillMode), so
// folding the player there would leave its bar over an empty column with no
// Home to open. A phone ignores panelMode and folds as usual.

export const OPEN_HOME_EVENT = "bb:open-home";
/** The streamer went live: a phone pane on ANY tab moves to Live, the same
 *  takeover the player makes. */
export const OPEN_LIVE_EVENT = "bb:open-live";

type VisitFold = {
  /** "fold" writes player_mode "none"; "unfold" writes the current tab's mode; null = leave it. */
  player: "fold" | "unfold" | null;
  /** Desktop only. null = leave the stored panel mode alone. */
  chat: "chatFolded" | "normal" | null;
  openHome: boolean;
};

export function foldForVisit(a: {
  live: boolean;
  narrow: boolean;
  storedPlayerMode: string | null;
  storedPanelMode: string | null;
}): VisitFold {
  const folded = a.storedPlayerMode === "none";
  const deliberate = a.storedPanelMode === "theatre" || a.storedPanelMode === "full";
  if (a.live) {
    return {
      player: folded ? "unfold" : null,
      chat: !a.narrow && a.storedPanelMode === "chatFolded" ? "normal" : null,
      openHome: false,
    };
  }
  if (!a.narrow && deliberate) return { player: null, chat: null, openHome: false };
  return {
    player: folded ? null : "fold",
    chat: a.narrow || a.storedPanelMode === "chatFolded" ? null : "chatFolded",
    openHome: true,
  };
}
