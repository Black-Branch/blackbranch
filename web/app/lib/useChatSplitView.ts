"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Room, MatrixEvent, RoomEvent } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { isIgnoredSender } from "@/app/lib/ignoredBots";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { useWindowState } from "@/app/lib/useClientState";

// RoomEvent.Timeline's literal, typed through the ERASED enum type. A value
// import of the enum from the SDK barrel puts all of matrix-js-sdk in the
// first-load bundle of every route that mounts the chat sidebar — this hook is
// eager, the SDK must not be (matrixSdkGraph.test.ts walks the graph;
// matrixDisplay.ts documents the type-only pattern).
const ROOM_TIMELINE = "Room.timeline" as RoomEvent.Timeline;

// Live/Matrix split view: default-on once the panel is wide enough for both
const SPLIT_AT = 640;
const LIVE_COL_DEFAULT = 320;
const LIVE_COL_MIN = 240;
const MATRIX_COL_MIN = 300;

// Tabs + responsive split layout + per-tab unseen-activity dots for the chat
// sidebar. Owns the panel-width measurement, the persisted split preference and
// live-column width, the divider drag, and which side is mounted/visible. The
// component reads the derived flags and wires `dividerHandlers`/`liveColStyle`
// straight into the JSX; the message hook calls `markLiveUnseen()` when a live
// message lands while the live side is hidden.
// `covered` — a mobile content tab (News/VODs) is open over the live/matrix
// pair, so NEITHER side is on screen no matter which one `tab` points at. Only
// the unseen-activity dots care: mounting and the split layout are unaffected
// (the covering tab hides the whole pair in the markup).
export function useChatSplitView(covered = false) {
  // General (live) chat is the default view; the only override is the user's
  // last-active tab. Anything but "matrix" → "live". Renders the SSR default
  // (null → "live") during hydration and the stored value right after — no
  // hydration mismatch and no restore/persist effect dance.
  //
  // WINDOW-SCOPED, not localStorage. localStorage syncs across tabs via the
  // `storage` event, so switching to the Matrix tab in one window would switch
  // it in every other open window. Which tab you are looking at is view state,
  // not a preference that should follow you around. It still survives reload
  // and still seeds a new window; see windowScoped.ts.
  const [savedTab, setSavedTab] = useWindowState("chatActiveTab");
  const tab: "live" | "matrix" = savedTab === "matrix" ? "matrix" : "live";
  const setTab: (t: "live" | "matrix") => void = setSavedTab;
  const [matrixOpened, setMatrixOpened] = useState(false);

  // ── Split view: live chat + Matrix side by side when the panel is wide
  // enough. Default on; expanding either side remembers the choice. ──
  const asideRef = useRef<HTMLElement>(null);
  const [panelW, setPanelW] = useState(0);
  const [splitPref, setSplitPrefState] = useState(() => lsGet("chatSplit") !== "0");
  const [liveColInit] = useState(() => {
    const v = parseInt(lsGet("liveColWidth") ?? "", 10);
    return isNaN(v) ? LIVE_COL_DEFAULT : v;
  });
  const liveColWRef = useRef(liveColInit);
  const liveColRef = useRef<HTMLDivElement>(null);
  const dividerDrag = useRef(false);
  // Absolute drag anchor (pointer X + column width at pointerdown), the same
  // pattern the Matrix panel dividers use (panelLayout.tsx): the width comes
  // from the cursor's absolute delta, never accumulated `movementX`, which
  // drifts under fractional DPI and is reported as 0 for WebKit touch — and
  // this divider is `touch-none`, so touch drags reach it.
  const dividerAnchor = useRef({ x: 0, w: 0 });

  const setSplitPref = useCallback((v: boolean) => {
    setSplitPrefState(v);
    lsSet("chatSplit", v ? "1" : "0");
  }, []);

  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const e = es[0];
      if (e) setPanelW(e.contentRect.width);
    });
    ro.observe(el);
    setPanelW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const splitAvailable = panelW >= SPLIT_AT;
  const split = splitAvailable && splitPref;
  const matrixVisible = split || tab === "matrix";
  const liveVisible = split || tab === "live";

  // Mount the Matrix side whenever it's visible — split, or the active tab
  // (incl. when the saved tab restores to "matrix" on load, which otherwise
  // left it unmounted until you toggled tabs). State adjust during render.
  if (matrixVisible && !matrixOpened) setMatrixOpened(true);

  // ── Unseen-activity dots on the tab titles ──
  // These track what is actually ON SCREEN, which is not the same as
  // `liveVisible`/`matrixVisible`: those describe the pair's internal layout,
  // and a content tab covering the pair leaves the "visible" side unseen. Using
  // the layout flags here meant the dots — mobile's whole activity signal —
  // stayed dark for the covered side the entire time a content tab was open.
  const liveShowing = liveVisible && !covered;
  const matrixShowing = matrixVisible && !covered;
  const { client: mxClient } = useMatrixClient();
  const [liveUnseen, setLiveUnseen] = useState(false);
  const [matrixUnseen, setMatrixUnseen] = useState(false);
  // Coming on screen clears that side's dot (render-time adjust, no effect pass).
  if (liveShowing && liveUnseen) setLiveUnseen(false);
  if (matrixShowing && matrixUnseen) setMatrixUnseen(false);
  // On-screen mirrors for the stable timeline/message handlers below.
  const liveVisibleRef = useRef(liveShowing);
  const matrixVisibleRef = useRef(matrixShowing);
  useEffect(() => {
    liveVisibleRef.current = liveShowing;
    matrixVisibleRef.current = matrixShowing;
  }, [liveShowing, matrixShowing]);
  useEffect(() => {
    if (!mxClient) return;
    const onTimeline = (ev: MatrixEvent, _room: Room | undefined, toStartOfTimeline?: boolean) => {
      if (toStartOfTimeline) return;
      if (ev.getType() !== "m.room.message") return;
      if (ev.getSender() === mxClient.getUserId()) return;
      // ⑤ Behavior: someone on the ignore list (a hidden person, a bridged bot)
      // never lights the dot — Community already hides their messages.
      if (isIgnoredSender({ client: mxClient }, ev)) return;
      if (!matrixVisibleRef.current) setMatrixUnseen(true);
    };
    mxClient.on(ROOM_TIMELINE, onTimeline);
    return () => { mxClient.off(ROOM_TIMELINE, onTimeline); };
  }, [mxClient]);

  // Flag live activity as unseen unless the live side is currently showing —
  // called by the message hook on each incoming live message.
  const markLiveUnseen = useCallback(() => {
    if (!liveVisibleRef.current) setLiveUnseen(true);
  }, []);

  // Width of the live column while split — clamped so the Matrix side keeps its
  // minimum. Recomputed from the live ref each render (the divider mutates the
  // ref + DOM directly mid-drag; this is the committed value).
  // eslint-disable-next-line react-hooks/refs -- deliberate: the drag writes ref+DOM without re-rendering; renders triggered by anything else must read the committed drag width or the column snaps back
  const liveColW = Math.max(LIVE_COL_MIN, Math.min(liveColWRef.current, Math.max(LIVE_COL_MIN, panelW - MATRIX_COL_MIN)));
  const liveColStyle: React.CSSProperties = { width: liveColW };

  // Plain-line divider: drag to resize the live column. Writes straight to the
  // ref + element style mid-drag (no re-render per pointer move), persisting the
  // committed width on release.
  const dividerHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      dividerDrag.current = true;
      dividerAnchor.current = { x: e.clientX, w: liveColWRef.current };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!dividerDrag.current || !liveColRef.current) return;
      const max = Math.max(LIVE_COL_MIN, panelW - MATRIX_COL_MIN);
      // The live column is on the left: dragging right grows it.
      const anchor = dividerAnchor.current;
      const w = Math.max(LIVE_COL_MIN, Math.min(max, anchor.w + (e.clientX - anchor.x)));
      liveColWRef.current = w;
      liveColRef.current.style.width = w + "px";
      // The split HEADER mirrors this width through a custom property on the
      // aside (ChatTabBar's Panes reads var(--live-col-w)); written here, not
      // via state, for the same reason as the column itself — no re-render per
      // pointer move. The committed value is re-seeded by ChatSidebar's render.
      asideRef.current?.style.setProperty("--live-col-w", w + "px");
    },
    onPointerUp: () => {
      dividerDrag.current = false;
      lsSet("liveColWidth", String(Math.round(liveColWRef.current)));
    },
    onPointerCancel: () => {
      dividerDrag.current = false;
      lsSet("liveColWidth", String(Math.round(liveColWRef.current)));
    },
  };

  return {
    asideRef,
    tab, setTab,
    split, splitAvailable, splitPref, setSplitPref,
    matrixVisible, liveVisible, matrixOpened, setMatrixOpened,
    liveUnseen, matrixUnseen, markLiveUnseen,
    liveColRef, liveColStyle, liveColW, dividerHandlers,
  };
}
