"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Room, MatrixEvent } from "matrix-js-sdk";
import { openOrCreateDm, rememberDm } from "@/app/lib/matrixDm";
import { useMatrixClient, useStartMatrixClient, MATRIX_READINESS_KEY } from "@/app/lib/MatrixClientContext";
import { useKeyboardLift } from "@/app/lib/useKeyboardLift";
import { Bar, BarButton, WindowLayerTarget, BootSequence } from "@/app/components/chrome";
import { X } from "@phosphor-icons/react/dist/ssr";
import { EMOTES_READINESS_KEY } from "@/app/lib/emoteReadiness";
import {
  getDmRoomIds,
  roomLabel,
  buildNav,
  buildServers,
  serverChannels,
  favouriteRooms,
  aggregateUnreads,
  isForumRoom,
  findRoomByAlias,
  CONTENT_SUGGESTIONS_ALIAS,
  type RailServer,
} from "@/app/lib/matrixRooms";
import { takePendingSuggestion, SUGGEST_EVENT } from "@/app/lib/contentSuggest";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { MatrixTimeline } from "./Timeline";
import { ForumView } from "./ForumView";
import { MemberList } from "./MemberList";
import { SpacesRail } from "./SpacesRail";
import { ChannelColumn } from "./ChannelColumn";
import { AddSpaceModal } from "./AddSpaceModal";
import { ThreadPanel } from "./ThreadPanel";
import { ThreadsListPanel } from "./ThreadsListPanel";
import AccountCard from "@/app/components/AccountCard";
import { ModWindow, isModPlace, type ModPlace } from "@/app/features/moderation";
import { AdminWindow, searchAdminPlaces } from "@/app/features/instance";
import { useCardStack } from "@/app/lib/useCardStack";
import { threadRootId } from "@/app/lib/matrixThreads";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { MODE2_AT, MODE3_AT, useContainerWidth, usePanelLayout } from "./panelLayout";
import { useCommunityBootstrap } from "./useCommunityBootstrap";
import {
  resolveVisibility,
  matrixPaneKeys,
  matrixActivePane,
  matrixPagerEnabled,
  type MatrixPaneKey,
} from "@/app/lib/matrixVisibility";
import { resolveCapacityChange } from "@/app/lib/matrixCapacity";
import { usePanePager } from "@/app/lib/chrome/usePanePager";
import { useClientValue } from "@/app/lib/useClientState";
import { Q_POINTER_COARSE } from "@/app/lib/deviceQueries";
import { useModPowerSync } from "@/app/lib/useModPowerSync";
import { useSiteBanSync } from "@/app/lib/siteBanSync";
import { useSiteMod } from "@/app/lib/useSiteMod";

/** The community pane's boot: the client's stages, then the emote catalog's. */
const COMMUNITY_BOOT = [MATRIX_READINESS_KEY, EMOTES_READINESS_KEY] as const;

// An INNER pager slot (the Matrix pane nests its own snap scroller). Same
// geometry contract as ChatSidebar's PANE_SLOT one layer out: full row width,
// never shrinking, its own snap stop, and `snap-always` so a swipe moves
// exactly one pane (which is also what makes every settle adjacent). Held as
// ONE string so the three slots that wear it cannot drift apart.
// Row-flex, not `flex-col`, on purpose: this slot stands in for the mode-1
// container — itself a row — so the rail sits BESIDE the channel column and the
// timeline / member children keep exactly the flex context they have off the pager.
const MX_PANE_SLOT = "w-full shrink-0 snap-start snap-always flex min-h-0 min-w-0";

// ─── width-driven capacity model ──────────────────────────────────────────────
//
// The open room (timeline) is the anchor; the directory (left) and member list
// (right) are slide-in toggles. The panel's own width — not the viewport —
// sets how many panels may coexist:
//   mode 1 (< 680px):  exactly one view at a time (mobile-Discord style)
//   mode 2 (≥ 680px):  timeline + at most one side panel (they push each other out)
//   mode 3 (≥ 1140px): directory open by default, members as an extra toggle

function UnifiedLayout({
  pageChrome = false,
  hideUserMenu = false,
}: {
  pageChrome?: boolean;
  hideUserMenu?: boolean;
}) {
  const { client, status, retry } = useMatrixClient();
  const [containerRef, width] = useContainerWidth();
  // Embedded (`layout="sidebar"`) this tree lives INSIDE the stream
  // chat panel, which already lifts — `enabled: pageChrome` is what prevents
  // the double lift.
  useKeyboardLift(containerRef, pageChrome);
  const mode = width >= MODE3_AT ? 3 : width >= MODE2_AT ? 2 : 1;
  const compact = mode === 1;

  // Adjustable, persisted side-panel widths + the drag-to-resize divider.
  const {
    panelResizing,
    panelDivider,
    dirWRef, dirOuterRef, dirInnerRef,
    memWRef, memOuterRef, memInnerRef,
    threadWRef, threadOuterRef, threadInnerRef,
  } = usePanelLayout();

  const [selected, setSelected] = useState<Room | null>(null);
  // A feed "Suggest" hand-off waiting to pre-fill the New Post modal (Content forum).
  const [pendingPost, setPendingPost] = useState<{ title: string; body: string } | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [membersOpen, setMembersOpen] = useState(false);
  // Right-panel thread view: the root event whose thread is open (in `selected`).
  const [threadRoot, setThreadRoot] = useState<MatrixEvent | null>(null);
  // Right-panel threads activity list (footer "Threads" button). Stays open
  // behind a single open thread so closing the thread returns to the list.
  const [threadsListOpen, setThreadsListOpen] = useState(false);
  // Discord rail: which "server" (top-level space) is active. null = derive from
  // the selected room (or first server); "home" = DMs + pinned view.
  const [activeServerId, setActiveServerId] = useState<string | "home" | null>(null);
  const [addSpaceOpen, setAddSpaceOpen] = useState(false);
  // Fallback account-card host — opened only when the rail avatar's cancelable
  // open-profile-card event goes UNCLAIMED (no UserMenu mounted, e.g. the
  // mobile directory view or a desktop empty state). Where a UserMenu IS
  // mounted (a timeline is showing) the hub claims via preventDefault() and
  // this never fires — exactly one card either way.
  // It is the SAME card with the same internal navigation, so /community's
  // fallback reaches every page (store, support, settings) too.
  const profileCard = useCardStack();
  // Mirrors UserMenu's modOpen: this fallback card host is the second required
  // mount for the mod window (onOpenMod on AccountCard/ProfileCardBody).
  const [modWindowOpen, setModWindowOpen] = useState(false);
  const [adminWindowOpen, setAdminWindowOpen] = useState(false);
  const [modPlace, setModPlace] = useState<ModPlace | undefined>(undefined);
  const [adminPlace, setAdminPlace] = useState<string | undefined>(undefined);
  // Whether the bootstrap should land General by default. False when a remembered
  // space exists (the restore effect owns landing then — avoids a General flash
  // and a race). Flipped true by the restore effect if that memory turns out stale.
  const [landDefaultRoom, setLandDefaultRoom] = useState(() => !lsGet("mx-lastspace"));
  // Which side panel the user touched last — survives capacity drops
  const lastSideRef = useRef<"dir" | "mem">("dir");
  const prevModeRef = useRef<number>(0);
  const myUserId = client?.getUserId() ?? "";

  // Joined rooms + pending invites + one-shot community bootstrap (hub/general
  // auto-join). Drives the rail + channel column; lands the timeline on General
  // without stealing a user pick (the `prev ?? room` guard lives here, in the
  // caller's setSelected).
  const { rooms, invites } = useCommunityBootstrap({
    client,
    status,
    onLandingRoom: (room) => setSelected((prev) => prev ?? room),
    landDefaultRoom,
  });

  // Feed "Suggest" → open the New Post modal in the Content forum, pre-filled with
  // the article title + link. Resolves (and joins if needed) the room, selects it,
  // and stashes the draft for ForumView to consume. Runs on the event AND on
  // (re)mount, since the click that fired it may have mounted this view.
  const processSuggestion = useCallback(async () => {
    if (!client) return;
    const s = takePendingSuggestion();
    if (!s) return;
    const known = client.getRooms();
    let room: Room | null =
      findRoomByAlias(known, CONTENT_SUGGESTIONS_ALIAS) ??
      known.find((r) => r.getMyMembership() === "join" && isForumRoom(r) && /content/i.test(r.name ?? "")) ??
      null;
    if (!room) {
      try {
        const res = await client.joinRoom(CONTENT_SUGGESTIONS_ALIAS);
        room = client.getRoom(res.roomId);
      } catch {
        room = null;
      }
    }
    if (!room) return;
    setActiveServerId(null); // let the rail derive the space from the selected room
    setSelected(room);
    // Open the room like a normal click would — close the channel directory and
    // members so the ForumView (and its New Post modal) actually renders in
    // single-panel mode, instead of staying hidden behind the channel list.
    setDirectoryOpen(false);
    setMembersOpen(false);
    setPendingPost({ title: s.title, body: s.link });
  }, [client]);

  // Microtask defer keeps processSuggestion()'s setStates out of the effect pass.
  useEffect(() => { Promise.resolve().then(processSuggestion); }, [processSuggestion]);
  useEffect(() => {
    const h = () => { processSuggestion(); };
    window.addEventListener(SUGGEST_EVENT, h);
    return () => window.removeEventListener(SUGGEST_EVENT, h);
  }, [processSuggestion]);

  // Memoized so a fresh Set/array isn't recomputed every render — a new
  // dmRoomIds Set each render would also defeat memoization in every child that
  // receives it. `rooms` (bumped by the refresh effect) is the change driver.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `rooms` is the deliberate change driver: getDmRoomIds(client) reads mutable client state the rule can't see
  const dmRoomIds = useMemo(() => getDmRoomIds(client), [client, rooms]);
  const nav = useMemo(() => buildNav(rooms, myUserId, dmRoomIds), [rooms, myUserId, dmRoomIds]);
  const servers = useMemo(() => buildServers(nav), [nav]);
  // Last-visited channel for a space, falling back to its first — the
  // `mx-lastch:` memory openRoom writes. ONE rule for both consumers (the
  // session-restore effect and the rail's server switch); they used to carry
  // two hand-written copies of it.
  const lastChannelFor = (srv: RailServer): Room | undefined => {
    const chans = serverChannels(srv);
    return chans.find((c) => c.roomId === lsGet(`mx-lastch:${srv.id}`)) ?? chans[0];
  };
  const dmUnreads = useMemo(() => aggregateUnreads(nav.dms), [nav]);
  const pinned = useMemo(() => favouriteRooms(rooms), [rooms]);
  // Pending invites light the Home rail tile (highlight-weight) so they're
  // discoverable even when the user never opens the Home view.
  const homeUnreads = useMemo(
    () => ({ total: dmUnreads.total + invites.length, highlight: dmUnreads.highlight + invites.length }),
    [dmUnreads, invites.length]
  );

  // Resolve the active server: explicit pick → server containing the open room →
  // first server. activeId drives the rail highlight + channel-column mode.
  const resolvedServer =
    activeServerId === "home"
      ? null
      : servers.find((s) => s.id === activeServerId) ??
        servers.find((s) => serverChannels(s).some((c) => c.roomId === selected?.roomId)) ??
        servers[0] ??
        null;
  const activeId: string | "home" =
    activeServerId === "home" ? "home" : resolvedServer?.id ?? "home";

  // Every channel in the active server plus the server room itself — what one
  // kick or ban covers. A stable callback, never an array: the
  // message row compares its props by identity and a fresh array each render
  // would re-render every row in the window on every event.
  const moderationScope = useCallback((): Room[] => {
    if (!resolvedServer) return selected ? [selected] : [];
    const chans = serverChannels(resolvedServer);
    return resolvedServer.room ? [...chans, resolvedServer.room] : chans;
  }, [resolvedServer, selected]);

  // Just the channels — "Mark all as read" must not try to mark the space room,
  // which carries no timeline.
  const serverRooms = useMemo(
    () => (resolvedServer ? serverChannels(resolvedServer) : selected ? [selected] : []),
    [resolvedServer, selected]
  );

  // Site mods get power 50 in every channel, reconciled from the owner's own
  // browser — see useModPowerSync's header for why this can't run server-side.
  useModPowerSync(client as unknown as Parameters<typeof useModPowerSync>[0], serverRooms, myUserId);
  // Site bans reach these channels, from a site mod's own client (siteBanSync.ts).
  const isSiteMod = useSiteMod();
  useSiteBanSync(isSiteMod ? client : null, serverRooms, myUserId);

  // Restore the last-used space on load instead of always landing on General.
  // One-shot, fires the moment `servers` is populated from local sync — which
  // beats useCommunityBootstrap's General landing (deferred behind its hub-join
  // + hierarchy network calls), so the restored room wins. Because the active
  // space is derived from the selected room when activeServerId is null, landing
  // the right channel is enough; we still set activeServerId for the "home" case
  // (DMs view, which has no single channel to land on).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || status !== "ready" || activeServerId !== null) return;
    // Microtask defer keeps the restore's setStates out of the effect pass
    // (cancelled if the deps change before it runs).
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled || restoredRef.current) return;
      const stored = lsGet("mx-lastspace");
      if (!stored) return; // no memory → keep the General default (don't latch)
      if (stored === "home") {
        restoredRef.current = true;
        setActiveServerId("home");
        return;
      }
      const srv = servers.find((s) => s.id === stored);
      if (!srv) {
        // Space not present. If sync has clearly settled (other servers exist) the
        // memory is stale → release the default General landing as a backstop;
        // otherwise it just hasn't synced yet → retry on the next update.
        if (servers.length > 0) { restoredRef.current = true; setLandDefaultRoom(true); }
        return;
      }
      const target = lastChannelFor(srv);
      if (!target) return;
      restoredRef.current = true;
      setSelected(target);
    });
    return () => { cancelled = true; };
  }, [status, servers, activeServerId]);

  // Capacity enforcement on mode changes. Mode 3 (wide) defaults the directory
  // open, but only as a one-shot when *entering* mode 3 — otherwise it would
  // re-force open on every render and the close button could never win.
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    // Rule lives in lib/matrixCapacity.ts so the one-shot mode-3 entry and the
    // mode-2 tie-break are testable — inline, both were invisible to review.
    const patch = resolveCapacityChange({
      mode,
      prevMode: prev,
      directoryOpen,
      membersOpen,
      lastSide: lastSideRef.current,
    });
    if (patch.directoryOpen !== undefined) setDirectoryOpen(patch.directoryOpen);
    if (patch.membersOpen !== undefined) setMembersOpen(patch.membersOpen);
  }, [mode, directoryOpen, membersOpen]);

  // Open an existing DM with `userId`, or create one (E2EE by default) — the
  // member-card "Message" action. (The chat user card's Message opens the DM
  // window instead: app/features/dm.) On open we drop
  // the side panels so the timeline shows (matters in single-panel mode).
  const openOrCreateDM = useCallback(
    async (userId: string) => {
      if (!client || status !== "ready") return;
      const showDM = (room: Room) => {
        setSelected(room);
        setDirectoryOpen(false);
        setMembersOpen(false);
      };

      // One code path with the terminal's `write`/`talk`: app/lib/matrixDm.ts.
      try {
        const room = await openOrCreateDm(client, userId);
        if (room) showDM(room);
      } catch (e) {
        console.error("[Matrix] DM create failed", e);
      }
    },
    [client, status]
  );

  // Accept a pending room/DM invite: join, and for DM invites mirror the
  // inviter→room mapping into our own m.direct account data (the invite's
  // is_direct flag lives on the member event; without this the accepted DM
  // wouldn't list under Direct Messages). Join-only — no crypto/session logic.
  const acceptInvite = useCallback(
    async (room: Room) => {
      if (!client || status !== "ready") return;
      try {
        await client.joinRoom(room.roomId);
        const inviter = room.getDMInviter();
        if (inviter) await rememberDm(client, inviter, room.roomId);
        setSelected(room);
        setDirectoryOpen(false);
        setMembersOpen(false);
      } catch (e) {
        console.warn("[Matrix] invite accept failed", room.roomId, e);
      }
    },
    [client, status]
  );

  // Decline a pending invite (leave drops it from the invite list via sync).
  const rejectInvite = useCallback(
    async (room: Room) => {
      if (!client || status !== "ready") return;
      try {
        await client.leave(room.roomId);
      } catch (e) {
        console.warn("[Matrix] invite decline failed", room.roomId, e);
      }
    },
    [client, status]
  );

  // Open a room into the timeline. `collapse` drops the directory drawer on
  // mobile (picking a channel) but not when auto-selecting after a server click.
  const openRoom = (room: Room, collapse: boolean) => {
    setSelected(room);
    const srv = servers.find((s) => serverChannels(s).some((c) => c.roomId === room.roomId));
    if (srv) {
      // Remember both the per-space last channel AND which space was last used,
      // so the next load can restore this space's view (see the restore effect).
      lsSet(`mx-lastch:${srv.id}`, room.roomId);
      lsSet("mx-lastspace", srv.id);
    }
    if (collapse && mode === 1) {
      setDirectoryOpen(false);
      setMembersOpen(false);
    }
  };

  const handleSelect = (room: Room) => openRoom(room, true);

  const handleSelectHome = () => {
    setActiveServerId("home");
    lsSet("mx-lastspace", "home");
    if (mode === 1) setDirectoryOpen(true);
  };

  const handleSelectServer = (id: string) => {
    setActiveServerId(id);
    if (mode === 1) setDirectoryOpen(true);
    const srv = servers.find((s) => s.id === id);
    if (!srv) return;
    const target = lastChannelFor(srv);
    if (target) openRoom(target, false);
  };

  const toggleDirectory = useCallback(() => {
    lastSideRef.current = "dir";
    setDirectoryOpen((o) => {
      const next = !o;
      if (next && mode <= 2) setMembersOpen(false);
      return next;
    });
  }, [mode]);

  const toggleMembers = useCallback(() => {
    lastSideRef.current = "mem";
    setMembersOpen((o) => {
      const next = !o;
      if (next && mode <= 2) setDirectoryOpen(false);
      if (next) { setThreadRoot(null); setThreadsListOpen(false); } // share the right slot
      return next;
    });
  }, [mode]);

  // Open the thread for an event in the right panel. If the event is itself a
  // thread reply, resolve to its root. Thread takes the right slot from members;
  // leaves the threads-list flag intact so closing returns to the list (if open).
  const openThread = useCallback(
    (ev: MatrixEvent) => {
      const rootId = threadRootId(ev);
      const rootEv = rootId === ev.getId() ? ev : selected?.findEventById(rootId) ?? ev;
      lastSideRef.current = "mem";
      setMembersOpen(false);
      setThreadRoot(rootEv);
      if (mode <= 2) setDirectoryOpen(false);
    },
    [mode, selected]
  );

  // Header "Threads" → toggle the per-channel activity list (shares right slot).
  const toggleThreadsList = useCallback(() => {
    lastSideRef.current = "mem";
    setThreadsListOpen((o) => {
      const next = !o || !!threadRoot; // if a single thread is open, snap to the list
      setThreadRoot(null);
      if (next) {
        setMembersOpen(false);
        if (mode <= 2) setDirectoryOpen(false);
      }
      return next;
    });
  }, [mode, threadRoot]);

  const closeThread = useCallback(() => setThreadRoot(null), []);
  const closeThreadsList = useCallback(() => setThreadsListOpen(false), []);
  // Full close of the right thread region (single thread + list).
  const closeRightThread = useCallback(() => { setThreadRoot(null); setThreadsListOpen(false); }, []);

  // Switching rooms closes any single open thread (its root belongs to the old
  // room). The threads-list panel stays open and just re-targets the new room.
  // Render-time adjust (no effect pass).
  const [threadRoom, setThreadRoom] = useState(selected);
  if (threadRoom !== selected) {
    setThreadRoom(selected);
    setThreadRoot(null);
  }

  // Rail "Threads activity" → jump to a room and open its threads list.
  const openRoomThreads = useCallback(
    (room: Room) => {
      setActiveServerId(null);
      setSelected(room);
      setThreadRoot(null);
      setMembersOpen(false);
      setThreadsListOpen(true);
      if (mode <= 2) setDirectoryOpen(false);
    },
    [mode]
  );

  // Thread (single), threads-list, and members all share the single right slot.
  // Priority: single thread → threads list → members.
  const threadEvent = threadRoot && selected ? threadRoot : null;

  // Visibility under the current capacity (pure resolver).
  const vis = resolveVisibility({
    mode,
    hasSelected: !!selected,
    directoryOpen,
    membersOpen,
    threadsListOpen,
    hasThreadEvent: !!threadEvent,
  });
  const { showDirectory, showTimeline, showMembers, showThread, showThreadsList } = vis;
  const showRightThread = showThread || showThreadsList;

  // ─── Inner pager ─────────────────────────────────────────────────────────────
  //
  // In mode 1 the three single-panel views become ONE nested snap row, so the
  // journey chat → matrix home → channel → user list → news is one continuous
  // swipe. The derivations are pure and live beside the resolver
  // (matrixVisibility.ts) — see matrixLayout.test.ts.
  //
  // The FLAGS stay the authority. `resolveVisibility` is untouched: a settle
  // writes `directoryOpen`/`membersOpen` through `commitMatrixPane`, and every
  // non-swipe path that writes them (openRoom's mode-1 collapse,
  // Timeline's onBack, toggleMembers, the members header's ←) keeps doing so
  // — usePanePager's external-sync effect turns those writes into an
  // instant scroll. That is a swap, not a slide.
  // "Mode 1 + touch only" — a desktop unsplit panel
  // (mode 1 on a FINE pointer) must not get a live, invisible snap row that a
  // trackpad pan or shift+wheel can silently page. `useClientValue` is the
  // house pattern for a client-only matchMedia read (PwaInstallNudge.tsx,
  // keepFocus.ts) — no reactive hook exists for Q_POINTER_COARSE on purpose
  // (useNarrowViewport.ts), and pointer coarseness does not change mid-session.
  const mxCoarse = useClientValue(() => window.matchMedia?.(Q_POINTER_COARSE)?.matches === true, false);
  const mxPagerOn = matrixPagerEnabled(mode, mxCoarse, vis);
  const mxPaneKeys = matrixPaneKeys(!!selected);
  const mxActivePane = matrixActivePane(vis);
  // Gate for MatrixTimeline's own
  // WindowLayerTarget: this INNER pager (directory | timeline | members)
  // can leave the timeline mounted OFF-SCREEN while another mx-pane shows —
  // `compact` alone doesn't see that. Registering "matrix" from an
  // off-screen timeline would capture a panel window opened from another
  // mx-pane (the rail-fallback account card below, a forum thread) onto an
  // invisible layer: it mounts with nothing to see, task-kind inerts an
  // off-screen region, and holds the back sentinel — the card doesn't open
  // and Back does nothing. True whenever the pager is off (nothing to be
  // off-screen behind) or the visible pane IS the timeline.
  const windowLayerActive = !mxPagerOn || mxActivePane === "timeline";
  const commitMatrixPane = useCallback((k: MatrixPaneKey) => {
    if (k === "directory") { setDirectoryOpen(true); setMembersOpen(false); return; }
    if (k === "timeline") { setDirectoryOpen(false); setMembersOpen(false); return; }
    setDirectoryOpen(false); setMembersOpen(true);
  }, []);
  const { scrollerRef: mxScrollerRef } = usePanePager<MatrixPaneKey>({
    keys: mxPaneKeys, activeKey: mxActivePane, enabled: mxPagerOn, onCommit: commitMatrixPane,
  });

  // Claimable handshake (see profileCardOpen): try to hand the rail avatar's
  // open to a mounted UserMenu; only host our own card if nothing claimed it.
  const openProfileCard = () => {
    const handled = dispatchClaimable("bb:open-profile-card");
    if (!handled) profileCard.open();
  };

  const railEl = (
    <SpacesRail
      servers={servers}
      activeId={activeId}
      homeUnreads={homeUnreads}
      canAddSpace={status === "ready"}
      onSelectHome={handleSelectHome}
      onSelectServer={handleSelectServer}
      onAddSpace={() => setAddSpaceOpen(true)}
      rooms={rooms}
      myUserId={myUserId}
      onOpenRoomThreads={openRoomThreads}
      // The rail avatar opens the universal profile card. It's dispatched as a
      // CANCELABLE window event: a mounted UserMenu claims it (preventDefault);
      // when unclaimed — the mobile directory view or a desktop empty state,
      // where no UserMenu is mounted — this view hosts its own card so the tap
      // is never dead. While a UserMenu IS mounted beside the rail (split),
      // the rail avatar is its duplicate and hides; the claimable
      // open-profile-card path above is unaffected — it still handles the
      // unclaimed case where the button still renders.
      onOpenSettings={openProfileCard}
      hideUserButton={hideUserMenu}
    />
  );
  // The DIRECTORY boots too. On a phone
  // (mode 1) with nothing selected `showTimeline` is false — the resolver
  // falls back to the directory — so the not-ready centre branch further down
  // never renders there, and without this a viewer would look at an EMPTY room
  // list for the whole boot and think the panel is empty. `!showTimeline` is
  // also what keeps exactly ONE sequence on screen: in modes 2/3 the centre
  // owns it and this is false.
  // `notoken` is not a loading state — the centre's sign-in CTA is the funnel,
  // so a signed-out visitor keeps the directory; a second CTA
  // here would just compete with it.
  const directoryBooting = showDirectory && !showTimeline && status !== "ready" && status !== "notoken";
  const channelColEl = (
    <ChannelColumn
      mode={activeId === "home" ? "home" : "space"}
      server={resolvedServer}
      dms={nav.dms}
      pinned={pinned}
      invites={invites}
      selected={selected}
      myUserId={myUserId}
      dmRoomIds={dmRoomIds}
      onSelect={handleSelect}
      onAcceptInvite={acceptInvite}
      onRejectInvite={rejectInvite}
      boot={directoryBooting ? <BootSequence keys={COMMUNITY_BOOT} label="Joining the community" onRetry={retry} /> : null}
      serverRooms={serverRooms}
    />
  );

  // ── Centre: the timeline (the anchor). ONE spelling, two render positions —
  // inside the pager row's `timeline` slot while the pager owns mode 1, and at
  // its own place in the container otherwise (which is every other mode). Two
  // copies here would be two things to keep in step; there is exactly one.
  // Keyed on the room so switching rooms re-runs the slide — that keyed
  // remount-per-room is deliberate and travels intact into the row.
  const mxTimelineEl = selected ? (
    <div key={selected.roomId} className="flex-1 flex flex-col min-w-0 panel-slide-in">
      {isForumRoom(selected) ? (
        <ForumView
          room={selected}
          myUserId={myUserId}
          compact={compact}
          onBack={mode === 1 ? () => setDirectoryOpen(true) : undefined}
          onToggleDirectory={mode >= 2 ? toggleDirectory : undefined}
          directoryOpen={directoryOpen}
          onToggleMembers={toggleMembers}
          membersOpen={membersOpen}
          onOpenPost={openThread}
          initialPost={pendingPost}
          onInitialConsumed={() => setPendingPost(null)}
        />
      ) : (
        <MatrixTimeline
          room={selected}
          myUserId={myUserId}
          compact={compact}
          hideUserMenu={hideUserMenu}
          windowLayerActive={windowLayerActive}
          onBack={mode === 1 ? () => setDirectoryOpen(true) : undefined}
          onToggleDirectory={mode >= 2 ? toggleDirectory : undefined}
          directoryOpen={directoryOpen}
          onToggleMembers={toggleMembers}
          membersOpen={membersOpen}
          onToggleThreads={toggleThreadsList}
          threadsOpen={showThreadsList}
          onOpenThread={openThread}
          activeThreadRootId={threadEvent?.getId() ?? null}
          onMessageUser={openOrCreateDM}
          moderationScope={moderationScope}
          serverRooms={serverRooms}
        />
      )}
    </div>
  ) : null;

  // ── Right: the member list, MODE-1 flavour (full panel, its own back bar).
  // ONE spelling, two render positions, exactly as the timeline above. Modes
  // 2/3 keep their own slide-in markup further down — a genuinely different
  // header (✕, no room label), not a duplicate of this one.
  const mxMembersEl = selected ? (
    <div className="flex flex-col min-h-0 flex-1">
      <Bar slot="top" name="mx-header" center={
        <>
          <button
            onClick={() => setMembersOpen(false)}
            className="text-secondary hover:text-strong text-sm px-1 shrink-0"
          >
            ←
          </button>
          <span className="text-sm font-medium text-body-dim flex-1 truncate">
            Members — {roomLabel(selected, myUserId, dmRoomIds)}
          </span>
        </>
      } />
      <MemberList room={selected} myUserId={myUserId} onMessage={openOrCreateDM} moderationScope={moderationScope} />
    </div>
  ) : null;

  // Committed drag widths — the dividers write these refs + the DOM directly
  // during a drag (no re-render per pointer move); renders triggered by anything
  // else must read the committed value or the panels snap back mid-drag.
  /* eslint-disable react-hooks/refs -- deliberate render-time reads of the committed drag widths (see above): the dividers write ref+DOM without re-rendering, so a render triggered by anything else must read the committed value or the panels snap back mid-drag */
  const dirW = dirWRef.current;
  const memW = memWRef.current;
  const threadW = threadWRef.current;
  /* eslint-enable react-hooks/refs */

  return (
    <div
      ref={containerRef}
      className={(pageChrome ? "h-full flex" : "flex-1 flex min-h-0") + " matrix-entrance"}
      // The entrance is a PURE derivation of `status` — no one-shot latch, and
      // deliberately so. Clearing `data-entered` from an `onAnimationEnd`
      // handler on this root would be wrong twice over. `animationend` BUBBLES,
      // so the handler would fire once per animating descendant and the FIRST
      // one to finish would strip the attribute out from under its
      // still-delayed siblings, cancelling their animations mid-flight and
      // snapping the stagger into a pop. And it would buy nothing: the only
      // element such a latch could protect against is the timeline's
      // room-KEYED div, which the entrance rules cannot reach at
      // all — it carries `.panel-slide-in` from the UNLAYERED globals.css,
      // which always beats chrome.css's `@layer components` on the `animation`
      // property (see chrome.css for the full reasoning), and the two-hop rule
      // stops at the `key="timeline"` wrapper, which is constant across rooms.
      // Nothing the entrance CAN reach remounts during a ready session: the
      // one-hop child is the pager scroller, the two-hop children are the rail,
      // the directory column, the dividers and the members column, and the
      // conditional siblings (AddSpaceModal, AccountCard, ModWindow) all portal
      // out of this subtree. A CSS animation plays when its selector STARTS
      // matching, so a stable attribute across re-renders replays nothing.
      // Re-introduce a one-shot only if an element the entrance rules can
      // actually reach starts remounting inside a ready session — and then not
      // with a bubbling `animationend`, which cannot tell the last box from the
      // first.
      // `notoken` is excluded by the same `status` value every other notoken
      // branch in this file already keys off (see `directoryBooting` above and
      // the sign-in branch below): it never reaches here as "ready", so a
      // signed-out visitor's sign-in CTA gets no entrance.
      data-entered={status === "ready" ? "" : undefined}
      style={{
        // Matrix mirrors the chat settings 1:1 — same font size, family, weight,
        // timestamp size, username font, and avatar scale — so the embedded client
        // and the live chat panel read as one cohesive, intentional surface.
        ...(pageChrome
          ? {
              background:
                "linear-gradient(to bottom right, var(--bg-body-start, #0c1020), var(--bg-body-end, #111827))",
            }
          : {}),
      } as React.CSSProperties}
    >
      {/* ── INNER PAGER WRAPPER ──────────────────────────────────────────────
           ONE PERMANENT ELEMENT IN TWO SKINS — never a ternary between two
           elements, and never conditionally rendered. Under the pager it is
           the mode-1 snap scroller (directory | timeline | members); off it,
           `display: contents` makes it disappear from layout entirely, so its
           children stay flex items of the root in the same DOM order and modes
           2/3 render as if it were not there.
           Why permanent: `mode` comes from this component's OWN container
           width, so it flips 1↔2 whenever the panel is resized — dragging
           ChatSidebar's split divider across 680px flips it repeatedly, MID-
           DRAG. A wrapper that came and went would change the timeline's
           parent on every one of those flips and remount it each time, losing
           the composer draft. `display: contents` is what buys
           a stable parent without adding a box.
           NO `overscroll-x-contain` on the pager skin, and that is the whole
           point: the inner row must CHAIN at its edges into the OUTER pager, so
           a fresh swipe off members' right edge continues to news and off
           directory's left edge back to live (one continuous journey,
           delivered by the browser's per-gesture scroll-target selection with
           zero handoff code). The outer row in ChatSidebar keeps its
           containment — there a rubber-band would become a history nav; here
           the neighbour IS the intended target. `overflow-y-hidden` because
           each pane owns its own vertical scroll.
           The ref is handed over unconditionally: every effect in usePanePager
           is `enabled`-guarded, so off the pager this ref is inert — and a ref
           that came and went would be one more thing changing across the flip.
           ── Mount parity across a flip ──
           · The TIMELINE survives: same `key="timeline"`, same JSX position,
             same depth in both skins — only its className changes. This is the
             one child that must not remount (it holds the scroll anchor and a
             composer draft).
           · The DIRECTORY composite and the MEMBERS region keep their
             mode ternaries and DO remount across a flip. Accepted: the loss is
             scroll position only, and mode 1 vs modes 2/3 members are
             genuinely different markup.
           · The thread region lives INSIDE this wrapper too — outside it, in
             modes 2/3 the members panel would render to the LEFT of an open
             thread. ─────────────────────────────────────────────────────── */}
      <div
        ref={mxScrollerRef}
        className={
          mxPagerOn
            ? "flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory no-scrollbar"
            : "contents"
        }
      >
      {/* Left: Discord rail (fixed) + channel column. In modes 2/3 the rail is
          always docked; toggling the directory collapses only the channel column.
          In mode 1 the rail + channel column overlay together as a drawer —
          or, under the pager, become the row's first pane. */}
      {mxPagerOn ? (
        <div key="directory" inert={mxActivePane !== "directory"} className={`${MX_PANE_SLOT} relative`}>
          {railEl}
          {channelColEl}
          {/* A panel window opened while THIS inner pane is the visible one
              (the rail avatar's account card, a directory context surface)
              needs a "matrix" target, or it falls back to the body-portal fade
              with no slide. Same one-visible-pane gate as Timeline's
              (windowLayerActive) so at most ONE "matrix" target is ever
              registered; no composer here, so the layer anchors to the pane
              bottom. `relative` makes this slot the layer's box. */}
          {mxActivePane === "directory" && <WindowLayerTarget pane="matrix" />}
        </div>
      ) : mode === 1 ? (
        showDirectory && (
          <div className="flex min-h-0 flex-1">
            {railEl}
            {channelColEl}
          </div>
        )
      ) : (
        <>
          {railEl}
          <div
            ref={dirOuterRef}
            className={`shrink-0 overflow-hidden flex ${
              panelResizing === "dir" ? "" : "transition-[width] duration-(--anim-default) ease-out"
            }`}
            style={{ width: showDirectory ? dirW : 0 }}
          >
            <div ref={dirInnerRef} style={{ width: dirW }} className="shrink-0 flex flex-col min-h-0">
              {channelColEl}
            </div>
          </div>
          {/* divider doubles as the panel border — drag to resize */}
          {showDirectory && panelDivider("dir")}
        </>
      )}

      {/* Centre: timeline (the anchor) — THE STABLE CHILD. One element, one
          key, one JSX position, one depth, in both skins: under the pager it
          wears the pane slot, off it `display: contents` so it adds no level
          and `mxTimelineEl` is a flex item of the root.
          That is what lets a mode flip (a split-divider drag across 680px)
          leave the timeline mounted, keeping its scroll anchor and composer
          draft. `contents` also when the pager is on but nothing is selected —
          the slot must then contribute NO pane, because matrixPaneKeys() says
          the row is one key wide there.
          Under the pager the timeline stays mounted alongside the active pane;
          off it, the resolver's `showTimeline` still gates it. */}
      <div
        key="timeline"
        inert={mxPagerOn && mxActivePane !== "timeline"}
        className={mxPagerOn && selected ? MX_PANE_SLOT : "contents"}
      >
        {(mxPagerOn || showTimeline) && mxTimelineEl}
      </div>
      {/* The empty-centre states (incl. the "Sign in to join" CTA). Unchanged:
          in mode 1 `showTimeline` is false whenever nothing is selected — the
          resolver falls back to the directory — so this branch renders only in
          modes 2/3, both before 5d and after it. The pager neither creates nor
          closes that mode-1 gap; what closes it is `directoryBooting` above —
          the boot shows in the DIRECTORY there, which is the pane a phone is
          actually looking at, and `!showTimeline` keeps the two branches
          mutually exclusive. Inside the wrapper, so its position among its
          siblings is the one it has always had. */}
      {showTimeline && !selected && (
        <div className="flex-1 flex items-center justify-center">
          {/* `notoken` is NOT a loading state — a signed-out visitor needs the
              sign-in path, not a boot sequence. Every other non-ready status
              boots through BootSequence, whose failed stage carries the retry. */}
          {status === "notoken" ? (
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              <p className="text-muted text-sm">Sign in to join the community.</p>
              <a
                href="/auth/signin"
                className="text-sm font-medium text-strong bg-surface-2 hover:bg-surface-3 border border-edge rounded px-4 py-2 transition-colors"
              >
                Sign in
              </a>
            </div>
          ) : status !== "ready" ? (
            // `error`, `loading` and the pre-start `idle` all show the boot
            // sequence: the stages say WHICH step is running or failed, and
            // a failed stage carries the retry (never a silently
            // stuck stage, never "refresh to try again").
            <BootSequence keys={COMMUNITY_BOOT} label="Joining the community" onRetry={retry} />
          ) : (
            <p className="text-muted text-sm">
              {activeId === "home" ? "Select a direct message" : "Select a channel"}
            </p>
          )}
        </div>
      )}

      {/* Right slot — thread region (single open thread OR the threads list).
          Shares the right region with the member list (thread region wins).
          Mode 1 = full panel; modes 2/3 = slide-in. */}
      {/* eslint-disable-next-line react-hooks/refs -- the IIFE only forwards ref objects to JSX ref= props and reads threadW (committed value hoisted above); no live ref reads happen here */}
      {showRightThread && selected && (() => {
        const inner = showThread && threadEvent ? (
          <ThreadPanel
            room={selected}
            rootEvent={threadEvent}
            myUserId={myUserId}
            compact={mode === 1}
            onBack={threadsListOpen ? closeThread : mode === 1 ? closeRightThread : undefined}
            onClose={closeRightThread}
            onMessageUser={openOrCreateDM}
            moderationScope={moderationScope}
          />
        ) : (
          <ThreadsListPanel room={selected} myUserId={myUserId} onOpenThread={openThread} onClose={closeThreadsList} onBack={mode === 1 ? closeThreadsList : undefined} />
        );
        return mode === 1 ? (
          <div className="flex flex-col min-h-0 flex-1">{inner}</div>
        ) : (
          <>
            {panelDivider("thread")}
            <div
              ref={threadOuterRef}
              className={`shrink-0 overflow-hidden flex ${
                panelResizing === "thread" ? "" : "transition-[width] duration-(--anim-default) ease-out"
              }`}
              style={{ width: threadW }}
            >
              <div ref={threadInnerRef} style={{ width: threadW }} className="shrink-0 flex flex-col min-h-0">
                {inner}
              </div>
            </div>
          </>
        );
      })()}

      {/* Right: member list — the row's third pane under the pager; slides
          in/out in modes 2/3; background inherits the host surface. Keeps its
          mode ternary and MAY remount across a flip (accepted ruling above). */}
      {mxPagerOn ? (
        /* The pane exists only with a room selected — matrixPaneKeys() says the
           same, so the row's children and the pager's key list cannot disagree
           about how many panes there are. Mounted alongside the active pane:
           the Matrix client is a context singleton. */
        selected && (
          <div key="members" inert={mxActivePane !== "members"} className={`${MX_PANE_SLOT} relative`}>
            {mxMembersEl}
            {/* Same open-flow gate as the directory slot above: a member tap
                opens the user card, and with no target it fell back to the
                body-portal fade. One visible pane, one registration. */}
            {mxActivePane === "members" && <WindowLayerTarget pane="matrix" />}
          </div>
        )
      ) : mode === 1 ? (
        /* Mode 1 off the pager (a thread or the threads list is open, so the
           row has yielded): the full-panel swap, the same element the
           row's `members` slot renders. */
        showMembers && mxMembersEl
      ) : (
        <>
          {/* divider doubles as the panel border — drag to resize */}
          {showMembers && selected && panelDivider("mem")}
          <div
            ref={memOuterRef}
            className={`shrink-0 overflow-hidden flex ${
              panelResizing === "mem" ? "" : "transition-[width] duration-(--anim-default) ease-out"
            }`}
            style={{ width: showMembers && selected ? memW : 0 }}
          >
          {selected && (
            <div ref={memInnerRef} style={{ width: memW }} className="shrink-0 flex flex-col min-h-0">
              <Bar slot="top" name="mx-header" center={
                <>
                  <span className="text-sm font-medium text-body-dim flex-1 truncate">
                    Members
                  </span>
                  <BarButton
                    icon={<X size={13} weight="bold" />}
                    label="Close members"
                    onClick={() => setMembersOpen(false)}
                  />
                </>
              } />
              <MemberList room={selected} myUserId={myUserId} onMessage={openOrCreateDM} moderationScope={moderationScope} />
            </div>
          )}
          </div>
        </>
      )}
      </div>
      {/* ── end of the pager wrapper. The modals below stay OUTSIDE it: they
           portal or overlay, and a snap-scroller child is the last thing an
           AddSpaceModal should be. ─────────────────────────────────────── */}

      {addSpaceOpen && client && (
        <AddSpaceModal
          onClose={() => setAddSpaceOpen(false)}
          onCreated={(roomId) => {
            setActiveServerId(roomId);
            setAddSpaceOpen(false);
          }}
        />
      )}

      {/* Unclaimed-rail fallback: the same account card a UserMenu would host.
          AccountCard's Window is presentation="floating" on desktop and
          "panel" on narrow (the host picks from the device signal, Window
          never reads matchMedia). Floating portals
          to <body> and escapes this flex layout without a wrapper here; on
          narrow the panel instead portals INTO the active pane's window
          layer (windowLayer.ts) — an element rendered INSIDE this flex
          layout by whichever pane (live/matrix/content) last reported itself
          active. Nothing here ever calls setActivePane, so on the /community
          page (no ChatSidebar mounted) the active pane is always unset and
          the panel falls back to the full-viewport shape, which DOES
          portal to <body> — same fallback /mod and the popout document hit.
          canonicalId is omitted — the card resolves it from /api/me so the
          stat pills + bot line still appear. */}
      {profileCard.stack && myUserId && (
        <AccountCard
          matrixId={myUserId}
          stack={profileCard.stack}
          onNavigate={profileCard.open}
          onBack={profileCard.back}
          onClose={profileCard.close}
          onOpenMod={() => setModWindowOpen(true)}
          onOpenAdmin={() => setAdminWindowOpen(true)}
        />
      )}

      {modWindowOpen && myUserId && (
        // No target here: this host has no user-card shield path — the row
        // open is the only door, and it carries no user.
        <ModWindow place={modPlace} searchAdmin={searchAdminPlaces}
          onClose={() => { setModWindowOpen(false); setModPlace(undefined); }}
          onOpenAdmin={(p) => { setAdminPlace(p); setAdminWindowOpen(true); }} />
      )}
      {adminWindowOpen && myUserId && <AdminWindow place={adminPlace}
        onOpenMod={(p) => { setModPlace(isModPlace(p) ? p : undefined); setModWindowOpen(true); }}
        onClose={() => { setAdminWindowOpen(false); setAdminPlace(undefined); }} />}

    </div>
  );
}

// ─── main export ──────────────────────────────────────────────────────────────

type MatrixViewProps =
  | {
      layout: "sidebar";
      hideUserMenu?: boolean;
    }
  | { layout: "expanded" };

export default function MatrixView(props: MatrixViewProps) {
  // Community intent: this is the single mount point for every community
  // surface (CommunityPage and MatrixPanel both render it), so it is where the
  // Matrix client starts. It is NOT started on page load — see
  // useStartMatrixClient. Called before the layout branch so the /sync begins
  // overlapping the user's navigation rather than following it.
  useStartMatrixClient();

  if (props.layout === "sidebar") {
    return (
      <UnifiedLayout hideUserMenu={props.hideUserMenu} />
    );
  }
  return <UnifiedLayout pageChrome />;
}
