"use client";

import Link from "next/link";
import { siteName } from "@/app/lib/siteName";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { GearSix, CornersOut, CaretUp, CaretDown, Broadcast } from "@phosphor-icons/react/dist/ssr";
import PlatformIcon from "./PlatformIcon";
import { Bar, BarButton, IconRail } from "@/app/components/chrome";
import { StreamModeMenu } from "./StreamModeMenu";
import {
  railModes, MODE_LABEL, modeHasMenu, liveOptions, communityOptions,
  type RailMode, type PlayerMode, type RailTone,
} from "@/app/lib/playerMode";
import { usePlayerFallbacks, type PlayerFallbacks } from "@/app/lib/plugins/player";
import type { LiveSource } from "@/app/lib/playerSource";
import type { PanelMode } from "@/app/lib/usePanelResize";

type StreamEmbedBarProps = {
  /** Desktop auto-hide (theatre / compact): parked past the top edge, revealed on proximity. */
  overlay: boolean;
  /** Out of the flow (mobile compact). */
  hidden: boolean;
  /** In flow — `occluded` itself changes no geometry — but the video column
   *  ramp independently translates the WHOLE column,
   *  this bar included, off the viewport (clipped by the root's
   *  overflow-hidden) while the keyboard is up; `occluded` makes that
   *  explicit for assistive tech (inert + aria-hidden) rather than relying
   *  on the clip alone. Mobile-keyboard-only. */
  occluded: boolean;
  /** "none" = folded: nothing selected, the rail is icons only. */
  mode: PlayerMode;
  /** Every mode's icon colour, derived in StreamView from the poll. */
  tones: Record<RailMode, RailTone>;
  /** The active mode's current option, after " · " — null when it has none. */
  detail: string | null;
  onSelectMode: (m: RailMode) => void;
  liveSource: LiveSource;
  /** The live sources that are on (the Stream tab's embed switches) — the drop-down's rows. */
  liveOn: readonly LiveSource[];
  onSelectLiveSource: (s: LiveSource) => void;
  /** The featured streamer's platforms — Community's dropdown, and the reason
   *  it has a caret at all (none when there is only one). */
  communityPlatforms: readonly { platform: string }[];
  communityPlatform: string | null;
  onSelectCommunityPlatform: (p: string) => void;
  folded: boolean;
  onFold: () => void;
  isMod: boolean;
  setShowEmbedMgr: (v: boolean) => void;
  narrow: boolean;
  panelMode: PanelMode;
  applyMode: (m: PanelMode) => void;
};

// All three sized in px at the same value — an icon sized in `em` against the
// bar's inherited font-size renders smaller than its neighbours inside the
// shared 1rem .chrome-iconrail-icon box and reads as off-centre.
// A registered fallback (app/lib/plugins/player.ts) brings its own icon and word.
const BUILTIN_ICON: Record<"live" | "community", ReactNode> = {
  live: <Broadcast size={14} weight="fill" />,
  community: <PlatformIcon platform="community" size={14} />,
};
const isBuiltin = (m: RailMode): m is "live" | "community" => m === "live" || m === "community";
function modeIcon(m: RailMode, fallbackFor: PlayerFallbacks["fallbackFor"]): ReactNode {
  if (isBuiltin(m)) return BUILTIN_ICON[m];
  const f = fallbackFor(m);
  return f ? <f.Icon size={14} weight="fill" /> : null;
}
const modeLabel = (m: RailMode, fallbackFor: PlayerFallbacks["fallbackFor"]): string =>
  (isBuiltin(m) ? MODE_LABEL[m] : fallbackFor(m)?.label ?? m);

// The video panel's top Bar: wordmark · the mode rail · one utility cluster.
// The rail's icons carry their state as colour; the selected mode expands and
// owns a dropdown of its own options — Live's four sources, Community's
// platforms for the featured streamer. Deliberately absent: a LIVE pill (the
// red icon is the status), an OFFLINE word, the marathon timer
// (StreamTimerIndicator is parked, not deleted), the featured streamer's name
// (it is on the bottom bar) and its platform dots (they are Community's
// dropdown), and jump-to-live (it needs the player APIs).
// Desktop auto-hide is Bar's `overlay`; mobile COMPACT is `hidden`; the mobile
// keyboard goes through `occluded` (never `hidden`). No seam
// shade: this sits inside the video frame, not over the chat surface. The
// bar's fill: solid video-bar bg in flow, the translucent overlay fill when
// floating.
export function StreamEmbedBar({
  overlay, hidden, occluded, mode, tones, detail, onSelectMode, liveSource, liveOn, onSelectLiveSource,
  communityPlatforms, communityPlatform, onSelectCommunityPlatform,
  folded, onFold, isMod, setShowEmbedMgr, narrow, panelMode, applyMode,
}: StreamEmbedBarProps) {
  // The fallbacks switched on (StreamView provides them).
  const { ids: fallbackIds, fallbackFor } = usePlayerFallbacks();
  // The menu belongs to ONE mode, so it is stored AS that mode rather than as
  // a boolean. The active mode changes without a click in here — the going-live
  // edge moves the tab, folding clears it — and a boolean would leave the
  // previous mode's options open, or make a dismissed menu reappear over the
  // new mode. Comparing against `active` closes it by DERIVATION, so no effect
  // has to chase the change (and `react-hooks/set-state-in-effect` is right to
  // refuse that effect: it is a cascading render for a value already known).
  const [menuFor, setMenuFor] = useState<RailMode | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  // The menu's outside-click anchor: the RAIL's own box, not the container
  // around it. The container is `flex-1` (it has to be — see its comment), so
  // it spans the whole gap between the wordmark and the cluster; anchoring
  // the dismiss to it would keep the menu open on a press anywhere in that
  // empty stretch of bar.
  const railAnchorRef = useRef<HTMLDivElement>(null);
  // Stable: StreamModeMenu registers it with the shared dismiss stack, so a new
  // identity every render would re-register the layer on every render.
  const closeMenu = useCallback(() => setMenuFor(null), []);
  const active: RailMode | null = mode === "none" ? null : mode;
  const menuOpen = menuFor !== null && menuFor === active;
  const items = railModes(fallbackIds).map((m) => ({
    key: m,
    label: modeLabel(m, fallbackFor),
    icon: modeIcon(m, fallbackFor),
    tone: tones[m] ?? "off",
    detail: m === active ? detail : null,
    hasMenu: modeHasMenu(m, { communityPlatforms: communityPlatforms.length, liveSources: liveOn.length }),
  }));
  return (
    <Bar
      slot="top"
      name="video-top"
      overlay={overlay}
      hidden={hidden}
      occluded={occluded}
      seam={false}
      background={overlay ? "var(--glass-bg)" : "var(--panel-bar-bg)"}
      leading={
        <Link
          href="/"
          className="font-bold text-strong tracking-tight shrink-0 leading-none"
          style={{ fontFamily: "var(--shell-font, inherit)", fontSize: "var(--wordmark-size, 0.875rem)" }}
        >
          {siteName()}
        </Link>
      }
      center={
        // `@container flex-1`: this wrapper is the size container the rail's
        // width-pressure tiers (chrome.css, .chrome-iconrail) measure — the
        // room the bar has between its wordmark and its cluster. `flex-1` is
        // what gives a contained flex item a width at all (inline-size
        // containment zeroes its content contribution); the tiers cannot sit
        // on the rail itself because a container query never matches its own
        // container.
        <div ref={railRef} className="relative @container flex-1 flex items-center min-w-0">
          <div ref={railAnchorRef} className="flex items-center min-w-0">
            <IconRail
              items={items}
              value={active}
              onChange={(m) => { setMenuFor(null); onSelectMode(m); }}
              label="Player mode"
              onMenu={(m) => setMenuFor((v) => (v === m ? null : m))}
              menuOpen={menuOpen}
            />
          </div>
          {menuOpen && active === "live" && liveOn.length > 1 && (
            <StreamModeMenu
              options={liveOptions(liveSource, liveOn)}
              onPick={(k) => onSelectLiveSource(k as LiveSource)}
              onClose={closeMenu}
              anchorRef={railAnchorRef}
            />
          )}
          {/* The same condition modeHasMenu gates the CARET on — one platform is
              not a choice. Repeated here because `menuFor` survives a change in
              the featured streamer: a menu opened over two platforms would
              otherwise stay open, one-row and inert, when the poll drops to one. */}
          {menuOpen && active === "community" && communityPlatforms.length > 1 && (
            <StreamModeMenu
              options={communityOptions(communityPlatforms, communityPlatform)}
              onPick={onSelectCommunityPlatform}
              onClose={closeMenu}
              anchorRef={railAnchorRef}
            />
          )}
        </div>
      }
      trailing={
        <>
          {/* Community embed management — mods/admins only. A BarButton like
              its neighbours (the universal style). */}
          {isMod && (
            <BarButton
              icon={<GearSix size={15} weight="bold" />}
              label="Manage community embeds"
              onClick={() => setShowEmbedMgr(true)}
            />
          )}
          {/* One-click theatre toggle — shortcut to the drag endpoint */}
          {!narrow && (
            <BarButton
              display="hidden md:flex"
              icon={<CornersOut size={14} weight="bold" />}
              label={panelMode === "theatre" ? "Exit theatre mode (Alt+R)" : "Theatre mode (Alt+R)"}
              active={panelMode === "theatre"}
              onClick={() => applyMode(panelMode === "theatre" ? "normal" : "theatre")}
            />
          )}
          {/* Fold — everything off. Desktop only; the phone folds by
              dragging the video column up. */}
          {!narrow && (
            <BarButton
              display="hidden md:flex"
              icon={folded ? <CaretDown size={13} weight="bold" /> : <CaretUp size={13} weight="bold" />}
              label={folded ? "Unfold player" : "Fold player"}
              onClick={onFold}
            />
          )}
        </>
      }
    />
  );
}
