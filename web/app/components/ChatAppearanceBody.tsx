"use client";

import { useState } from "react";
import { Rail, RailLayout } from "@/app/components/chrome";
import ChatPrefs from "./ChatSettings";
import { TABS, type MenuTab } from "@/app/lib/settingsMenu";

// The chat appearance page of the account card. The five sections are a
// vertical Rail here in the body (AccountCard owns which section is active, so
// it survives page navigation); the window band shows the page title, like
// every other page.
//
// Search sits with the rail: five sections over 25 groups is a hunt without
// it. The query is local state — it is a transient lens, not a preference.
// While searching, the content shows matches from EVERY section (each under
// its group title); picking a section clears the search.
export default function ChatAppearanceBody({
  tab,
  onTab,
  onShowTimestampsChange,
  onShowMatrixNameChange,
}: {
  tab: MenuTab;
  onTab: (t: MenuTab) => void;
  onShowTimestampsChange?: (v: boolean) => void;
  onShowMatrixNameChange?: (v: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  // Where ChatPrefs renders its saved looks + Reset: a fixed row between the
  // search and the rail (the top buttons stay put while only the list
  // scrolls). A callback ref in state, so ChatPrefs re-renders into it.
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const q = search.trim();
  return (
    // The size container for RailLayout's icon-rail query lives HERE, on the
    // layout's parent: a container query cannot match its own container.
    // Search sits ABOVE the layout, full width, at every width — one placement.
    // Inside the rail column it would become a 44px sliver once the rail
    // collapses to icons.
    <div data-scroll-inner className="p-3" style={{ containerType: "inline-size" }}>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search"
        aria-label="Search settings"
        className="mb-2 w-full shrink-0 rounded bg-raised border border-edge px-2 py-1 text-xs text-body placeholder:text-muted focus:outline-none focus:border-strong"
      />
      <div ref={setHeaderSlot} className="shrink-0" />
      <RailLayout
        fill
        compactHeading={q ? null : TABS.find((t) => t.key === tab)?.label}
        rail={
          <Rail
            items={TABS}
            value={tab}
            onChange={(t) => {
              setSearch("");
              onTab(t);
            }}
            label="Appearance sections"
          />
        }
      >
        <ChatPrefs
          activeTab={q ? undefined : tab}
          search={q || undefined}
          onShowTimestampsChange={onShowTimestampsChange}
          onShowMatrixNameChange={onShowMatrixNameChange}
          headerSlot={headerSlot}
        />
      </RailLayout>
    </div>
  );
}
