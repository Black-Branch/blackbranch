"use client";

// The Mod Panel's body: Chat history · Mod history · Bans · Chat controls (Display, Slow mode, the
// automod queue and word lists, Purge) · Lockdown · Identity links — as the account windows
// lay out a multi-section page: a search across the top, then the rail of places beside the
// place's content. On a narrow window the rail folds into a picker at the top.
// The search also lists the Admin Panel's places that match, for an admin.
//
// Hosts: ModWindow — the floating / slide-in window, and the /mod pop-out, which renders the same
// window as a page. Writes all go through the mod-gated /api/mod/* routes.

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import {
  ChatsCircle, ClockCounterClockwise, Prohibit, SlidersHorizontal, LockKey, LinkSimple, Flag,
} from "@phosphor-icons/react/dist/ssr";
import { Rail, RailLayout } from "@/app/components/chrome";
import type { PanelPlace } from "@/app/lib/panelSearch";
import IdentitySection from "./IdentitySection";
import DisplaySection from "./sections/DisplaySection";
import AutomodSection from "./sections/AutomodSection";
import MarksSection from "./sections/MarksSection";
import WordListSection from "./sections/WordListSection";
import SlowModeSection from "./sections/SlowModeSection";
import LockdownSection from "./sections/LockdownSection";
import BanSection from "./sections/BanSection";
import ReportsSection from "./sections/ReportsSection";
import PurgeSection from "./sections/PurgeSection";
import ChatHistorySection from "./sections/ChatHistorySection";
import HistorySection from "./sections/HistorySection";
import OtherPanelHits from "./OtherPanelHits";
import ModUndoToast from "@/app/components/ModUndoToast";
import { popOutChatHistory } from "./ChatHistoryWindow";
import { MOD_PLACES, MOD_TARGET_PLACE, modSearch, type ModPlace } from "./modLayout";

const ic = (C: typeof ChatsCircle) => createElement(C, { size: 18, weight: "bold" });
const ICON: Record<ModPlace, ReturnType<typeof ic>> = {
  chat: ic(ChatsCircle), history: ic(ClockCounterClockwise), bans: ic(Prohibit), reports: ic(Flag), controls: ic(SlidersHorizontal),
  lockdown: ic(LockKey), identity: ic(LinkSimple),
};

// initialTarget: prefills the Ban + Purge target inputs — a user card's shield passes the person,
// and the panel opens on Bans. initialPlace: another panel's search opened this one on a place.
export default function ModPanel({ initialTarget, initialPlace, searchAdmin, onOpenAdmin }: {
  initialTarget?: string;
  initialPlace?: ModPlace;
  /** The Admin Panel's places matching a query — given to admins only. */
  searchAdmin?: (query: string) => PanelPlace[];
  /** Opens the Admin Panel on a place (its id). */
  onOpenAdmin?: (place?: string) => void;
}) {
  const [place, setPlace] = useState<ModPlace>(initialPlace ?? (initialTarget ? MOD_TARGET_PLACE : "chat"));
  const [seenPlace, setSeenPlace] = useState(initialPlace);
  if (initialPlace !== seenPlace) { setSeenPlace(initialPlace); if (initialPlace) setPlace(initialPlace); }
  const [search, setSearch] = useState("");
  // A report's "Ban…" opens Bans on the reported person.
  const [banTarget, setBanTarget] = useState(initialTarget);
  const [seenTarget, setSeenTarget] = useState(initialTarget);
  if (initialTarget !== seenTarget) { setSeenTarget(initialTarget); setBanTarget(initialTarget); }
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const note = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 5000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const matches = modSearch(search);
  // A search that hides the open place shows its first match instead.
  const shown: ModPlace = matches.includes(place) ? place : (matches[0] ?? place);
  const items = MOD_PLACES.filter((p) => matches.includes(p.key)).map((p) => ({ key: p.key, label: p.label, icon: ICON[p.key] }));
  const label = MOD_PLACES.find((p) => p.key === shown)?.label;
  const elsewhere = searchAdmin && onOpenAdmin ? searchAdmin(search) : [];

  return (
    // The size container for RailLayout's narrow query is this wrapper — a container query
    // cannot match its own container (chrome.css). The search sits above the layout, full width.
    <div data-scroll-inner className="p-3" style={{ containerType: "inline-size" }}>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search"
        aria-label="Search the mod panel"
        className="mb-2 w-full shrink-0 rounded bg-raised border border-edge px-2 py-1 text-xs text-body placeholder:text-muted focus:outline-none focus:border-strong"
      />
      {elsewhere.length > 0 && onOpenAdmin && (
        <OtherPanelHits title="In the admin panel" hits={elsewhere} onOpen={(h) => { setSearch(""); onOpenAdmin(h.id); }} />
      )}
      {flash && (
        <div role="status" className="mb-2 shrink-0 rounded-lg px-3 py-2 text-sm bg-surface-2 border border-edge text-body">{flash}</div>
      )}
      <RailLayout
        fill
        compact="picker"
        pickerLabel={label}
        current={shown}
        rail={
          items.length
            ? <Rail items={items} value={shown} onChange={(k) => { setPlace(k); setSearch(""); }} label="Mod panel sections" />
            : <p className="p-2 text-xs text-muted">Nothing matches here.</p>
        }
      >
        <div className="space-y-4 pb-3">
          {shown === "chat" && <ChatHistorySection onPopout={popOutChatHistory} />}
          {shown === "history" && <HistorySection note={note} />}
          {shown === "bans" && <BanSection key={banTarget ?? ""} note={note} initialTarget={banTarget} />}
          {shown === "reports" && <ReportsSection note={note} onBan={(id) => { setBanTarget(id); setPlace("bans"); }} />}
          {shown === "controls" && (
            <>
              <DisplaySection />
              <SlowModeSection note={note} />
              <AutomodSection note={note} />
              <MarksSection note={note} />
              <WordListSection note={note} />
              <PurgeSection note={note} initialTarget={initialTarget} />
            </>
          )}
          {shown === "lockdown" && <LockdownSection note={note} />}
          {shown === "identity" && <IdentitySection note={note} />}
        </div>
      </RailLayout>
      {/* Undo and "which platforms it reached" for actions taken here; draws only when no
          other host (live chat) already does. */}
      <ModUndoToast />
    </div>
  );
}
