"use client";

import { ShieldStar, GearSix } from "@phosphor-icons/react/dist/ssr";
import { Window, BarButton } from "@/app/components/chrome";
import { useNarrowViewport } from "@/app/lib/useNarrowViewport";
import { useWindowDock } from "@/app/lib/chrome/windowDock";
import { useIsAdmin } from "@/app/lib/useIsAdmin";
import type { PanelPlace } from "@/app/lib/panelSearch";
import ModPanel from "./ModPanel";
import type { ModPlace } from "./modLayout";

// The mod panel as its own tool window: the band carries the
// shield mark and the title, like every other window — the places are the body's rail, with a
// search above it, the account windows' layout. Admins get an Admin panel button in the band:
// the one way in from here, never a text link.
//
// Hosted by whoever hosts the account card (UserMenu; MatrixView's unclaimed-rail fallback) and
// mounted only while open. Both hosts share the storageKey so the geometry follows the mod. The
// /mod pop-out renders this same window as a page (`popout`), so the pop-out and the window are one
// thing.
export default function ModWindow({ target, place, onClose, onOpenAdmin, searchAdmin, popout = false }: {
  /** Prefills Ban/Purge — a user card's shield passes the clicked user. */
  target?: string;
  /** Opens on this place (the Admin Panel's search opened it). */
  place?: ModPlace;
  onClose: () => void;
  /** Opens the host's Admin window, on a place when one is given. The band shows the button to
   *  admins only. */
  onOpenAdmin?: (place?: string) => void;
  /** The Admin Panel's places matching a query. The host passes it — this
   *  feature does not import the Admin Panel's. Shown to admins only. */
  searchAdmin?: (query: string) => PanelPlace[];
  /** The /mod page: the same window as a full page, no pop-out control. */
  popout?: boolean;
}) {
  const narrow = useNarrowViewport();
  const docked = useWindowDock("mod", narrow);
  // The pop-out is the same window as a page: no dock switch, no pop-out control.
  const win: { presentation: "page" | "panel" | "floating"; dock?: typeof docked.dock } = popout ? { presentation: "page" } : docked;
  const isAdmin = useIsAdmin();
  const adminButton = isAdmin && onOpenAdmin ? (
    <BarButton icon={<GearSix size={13} weight="bold" />} label="Admin panel" onClick={() => onOpenAdmin()} />
  ) : null;
  return (
    <Window
      presentation={win.presentation}
      dock={win.dock}
      kind="task"
      name="Mod panel"
      mark={<ShieldStar size={14} weight="bold" />}
      title="Mod panel"
      actions={adminButton}
      storageKey="bb_modpanel_geom"
      defaultSize={{ w: 760, h: 640 }}
      minWidth={720}
      popoutUrl={popout ? undefined : "/mod"}
      onClose={onClose}
    >
      <ModPanel initialTarget={target} initialPlace={place} searchAdmin={isAdmin ? searchAdmin : undefined} onOpenAdmin={isAdmin ? onOpenAdmin : undefined} />
    </Window>
  );
}
