"use client";

import { useState } from "react";
import { Window } from "@/app/components/chrome";
import { useNarrowViewport } from "@/app/lib/useNarrowViewport";
import { useWindowDock } from "@/app/lib/chrome/windowDock";
import { PRODUCT_MARK } from "@/app/lib/siteIcons";
import AdminPanel from "./AdminPanel";
import { ADMIN_HOME, adminHref, adminPlaceParts, type AdminSection } from "./adminLayout";

// The Admin Panel as a tool window, the same shape as the mod window and the
// account windows: the product's mark + "Admin panel" in the band, the rail of places with a search
// in the body. Opened from the profile card's row and from the mod window's band (admins only),
// hosted where the mod window is. The /admin/<section> pages render this same window as a page
// (`popout`), keeping each place's URL in the address bar.
export default function AdminWindow({ onClose, section: sectionProp = ADMIN_HOME, sub: subProp, place, onOpenMod, popout = false }: {
  onClose: () => void;
  /** A place id (`ai/bot`) to open on — another panel's search asked for it. Wins over section/sub. */
  place?: string;
  /** Opens the Mod Panel on a place (the search lists the mod panel's places too). */
  onOpenMod?: (place: string) => void;
  section?: AdminSection;
  sub?: string;
  /** The /admin page: the same window as a full page, with the place in the URL. */
  popout?: boolean;
}) {
  const asked = place ? adminPlaceParts(place) : null;
  const section = asked?.section ?? sectionProp;
  const sub = asked ? (asked.sub ?? undefined) : subProp;
  const narrow = useNarrowViewport();
  // The pop-out opens the place on screen.
  const [href, setHref] = useState(() => adminHref({ section, sub: sub ?? null }));
  const docked = useWindowDock("admin", narrow);
  const win: { presentation: "page" | "panel" | "floating"; dock?: typeof docked.dock } = popout ? { presentation: "page" } : docked;
  return (
    <Window
      presentation={win.presentation}
      dock={win.dock}
      kind="task"
      name="Admin panel"
      // The product's mark: the panel is the product's, whatever icons the site itself uses.
      mark={<img src={PRODUCT_MARK} alt="" width={14} height={14} className="size-3.5" />}
      title="Admin panel"
      storageKey="bb_adminpanel_geom"
      defaultSize={{ w: 860, h: 680 }}
      minWidth={720}
      popoutUrl={popout ? undefined : href}
      onClose={onClose}
    >
      <AdminPanel section={section} initialSub={sub} syncUrl={popout} onPlace={setHref} onOpenMod={onOpenMod} />
    </Window>
  );
}
