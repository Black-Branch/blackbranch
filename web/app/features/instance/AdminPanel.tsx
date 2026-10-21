"use client";

// The Admin Panel's body: the one home for this install's settings — AI · Utility · Payments ·
// Platforms · Site · Doctor · Updates. The layout is the account windows' layout — a search across
// the top, then ONE rail of every place (grouped by section, OBS's own places nested under it)
// beside the place's content.
//
// Switching places is client state inside this one mounted panel: focus stays on the rail,
// what was loaded stays loaded. In the page form (`/admin/<section>`, the pop-out) each switch
// writes the place's URL with history.pushState and back/forward re-read it, so a place is still a
// link; the floating window leaves the address bar alone.
//
// Every route behind this checks is_admin itself; the page's server guard and this component are
// not the guard.

import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Cpu, Robot, ChartBar, ShieldCheck, Lifebuoy, Database, VideoCamera, SpeakerHigh,
  ClockCounterClockwise, CreditCard, YoutubeLogo, TwitchLogo, Broadcast, Butterfly, DiscordLogo,
  GlobeSimple, Coins, PuzzlePiece, Timer, Gauge, Sparkle, Medal, Ticket, Brain, Stethoscope, ArrowsClockwise, Browsers,
} from "@phosphor-icons/react/dist/ssr";
import { Rail, RailLayout } from "@/app/components/chrome";
import { getJson } from "@/app/lib/http";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { ADMIN_PLUGIN_PANELS } from "@/app/lib/plugins/admin";
import {
  PaymentHistory, TimerControls, SupportBarControls, EffectsControls, BadgesAdmin, SupportTickets, ModeratorList,
  OtherPanelHits, searchModPlaces,
} from "@/app/features/moderation";
import {
  adminRail, adminItemFor, adminHref, adminSearch, keyGroupsFor, guidesFor, isAdminSection,
  type AdminSection, type AdminRailItem, type AiSub,
} from "./adminLayout";
import SetupGuides from "./SetupGuides";
import { ProcessStrip } from "./parts";
import KeyCards from "./KeyCards";
import AiPanel from "./AiPanel";
import PointsPanel from "./PointsPanel";
import DoctorPanel from "./DoctorPanel";
import UpdatesPanel from "./UpdatesPanel";
import RigPanel from "./RigPanel";
import OverlaysPanel from "./OverlaysPanel";
import DiscordNote from "./DiscordNote";

const ic = (C: typeof Cpu) => createElement(C, { size: 18, weight: "bold" });
const ICON: Record<string, ReactNode> = {
  "ai/models": ic(Cpu), "ai/bot": ic(Robot), "ai/scoring": ic(ChartBar), "ai/automod": ic(ShieldCheck), "ai/helpdesk": ic(Lifebuoy), "ai/embeddings": ic(Database),
  "utility/obs": ic(VideoCamera), "utility/timer": ic(Timer), "utility/bar": ic(Gauge), "utility/effects": ic(Sparkle), "utility/tts": ic(SpeakerHigh), "utility/overlays": ic(Browsers),
  "payments/history": ic(ClockCounterClockwise), "payments/connections": ic(CreditCard),
  "platforms/youtube": ic(YoutubeLogo), "platforms/twitch": ic(TwitchLogo), "platforms/kick": ic(Broadcast), "platforms/streamplace": ic(Butterfly), "platforms/discord": ic(DiscordLogo),
  "site/general": ic(GlobeSimple), "site/points": ic(Coins), "site/modules": ic(PuzzlePiece), "site/badges": ic(Medal), "site/tickets": ic(Ticket),
  doctor: ic(Stethoscope), updates: ic(ArrowsClockwise),
};
const PLUGIN_ICON = ic(Brain);

/** Where the page form's URL points, read back after back/forward. */
function placeFromLocation(): { section: AdminSection; sub: string | null } | null {
  const m = /^\/admin\/([^/?#]+)/.exec(window.location.pathname);
  if (!m || !isAdminSection(m[1]!)) return null;
  return { section: m[1] as AdminSection, sub: new URLSearchParams(window.location.search).get("sub") };
}

export default function AdminPanel({ section, initialSub, syncUrl = false, onPlace, onOpenMod }: {
  section: AdminSection;
  initialSub?: string;
  /** Opens the Mod Panel on a place — the search lists its places too. */
  onOpenMod?: (place: string) => void;
  /** The page form: keep `/admin/<section>?sub=<sub>` in the address bar. */
  syncUrl?: boolean;
  /** Told the open place's URL on every switch (the window's pop-out opens that place). */
  onPlace?: (href: string) => void;
}) {
  const rail = useMemo(() => adminRail(ADMIN_PLUGIN_PANELS), []);
  const [itemId, setItemId] = useState<string>(() => adminItemFor(rail, section, initialSub).id);
  // A new place asked for from outside (the mod panel's search) moves the open panel there.
  const asked = `${section}/${initialSub ?? ""}`;
  const [seenAsk, setSeenAsk] = useState(asked);
  if (asked !== seenAsk) { setSeenAsk(asked); setItemId(adminItemFor(rail, section, initialSub).id); }
  const [search, setSearch] = useState("");

  // Back/forward in the page form: the URL is the truth for which place shows.
  useEffect(() => {
    if (!syncUrl) return;
    const onPop = () => {
      const p = placeFromLocation();
      if (p) setItemId(adminItemFor(rail, p.section, p.sub).id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [syncUrl, rail]);

  const go = useCallback((id: string) => {
    setItemId(id);
    setSearch("");
    const it = rail.find((x) => x.id === id);
    // Native pushState: Next (≥ 14.1) syncs usePathname/useSearchParams with it and does NOT
    // re-render the server page — the panel stays mounted, focus stays on the rail.
    if (!it) return;
    if (syncUrl) window.history.pushState(null, "", adminHref(it));
    onPlace?.(adminHref(it));
  }, [rail, syncUrl, onPlace]);

  const [inst, setInst] = useState<InstanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const loadInst = useCallback(() => {
    getJson<InstanceView>("/api/admin/instance", { cache: "no-store" })
      .then((v) => { setInst(v); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => { loadInst(); }, [loadInst]);

  const matches = adminSearch(rail, search);
  const item: AdminRailItem = matches.find((x) => x.id === itemId) ?? matches[0] ?? rail.find((x) => x.id === itemId) ?? rail[0]!;
  const elsewhere = onOpenMod ? searchModPlaces(search) : [];
  const items = matches.map((x) => ({
    key: x.id, label: x.label, group: x.group, depth: x.depth, icon: ICON[x.id] ?? (x.plugin ? PLUGIN_ICON : undefined),
  }));

  return (
    // The size container for RailLayout's icon-rail query is this wrapper — a container query
    // cannot match its own container (chrome.css).
    <div data-scroll-inner className="p-3" style={{ containerType: "inline-size" }}>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search settings"
        aria-label="Search the admin panel"
        className="mb-2 w-full shrink-0 rounded bg-raised border border-edge px-2 py-1 text-xs text-body placeholder:text-muted focus:outline-none focus:border-strong"
      />
      {elsewhere.length > 0 && onOpenMod && (
        <OtherPanelHits title="In the mod panel" hits={elsewhere} onOpen={(h) => { setSearch(""); onOpenMod(h.id); }} />
      )}
      {inst && <div className="mb-2 shrink-0"><ProcessStrip procs={inst.processes} /></div>}
      {msg && <p role="status" className="mb-2 shrink-0 rounded-lg border border-edge bg-surface-1 px-3 py-2 text-xs text-body-dim break-words">{msg}</p>}
      <RailLayout
        fill
        compact="picker"
        pickerLabel={`${item.group} · ${item.label}`}
        current={item.id}
        rail={
          items.length
            ? <Rail items={items} value={item.id} onChange={go} label="Admin panel sections" fold foldKey="bb_admin_rail_open" expandAll={!!search.trim()} />
            : <p className="p-2 text-xs text-muted">Nothing matches here.</p>
        }
      >
        <div className="space-y-4 pb-3">
          <AdminPlace item={item} inst={inst} error={error} loadInst={loadInst} note={setMsg} go={go} />
        </div>
      </RailLayout>
    </div>
  );
}

function AdminPlace({ item, inst, error, loadInst, note, go }: {
  item: AdminRailItem; inst: InstanceView | null; error: string | null; loadInst: () => void; note: (m: string) => void;
  /** Opens another place (an empty state's link to its setup). */
  go: (id: string) => void;
}) {
  const { section, sub } = item;
  // A plugin's place renders its own panel.
  if (item.plugin) {
    const P = ADMIN_PLUGIN_PANELS.find((p) => p.section === section && p.key === sub);
    return P ? <P.Panel note={note} /> : null;
  }
  // These read their own data; they do not wait for the settings view.
  if (section === "doctor") return <DoctorPanel />;
  if (section === "updates") return <UpdatesPanel />;
  if (section === "payments" && sub === "history") return <PaymentHistory onSetup={() => go("payments/connections")} />;
  if (section === "utility" && sub === "timer") return <TimerControls note={note} />;
  if (section === "utility" && sub === "bar") return <SupportBarControls note={note} />;
  if (section === "utility" && sub === "effects") return <EffectsControls note={note} />;
  if (section === "site" && sub === "badges") return <BadgesAdmin />;
  if (section === "site" && sub === "tickets") return <SupportTickets note={note} />;
  if (section === "site" && sub === "moderators") return <ModeratorList note={note} />;
  if (section === "utility" && sub === "overlays") return <OverlaysPanel go={go} />;
  if (error) return <p className="text-sm text-red-300">Could not load the settings: {error}</p>;
  if (!inst) return <p role="status" className="text-sm text-muted">Loading settings…</p>;
  if (section === "ai") return <AiPanel sub={sub as AiSub} inst={inst} reloadInst={loadInst} note={note} />;
  if (section === "site" && sub === "points") return <PointsPanel inst={inst} reloadInst={loadInst} note={note} />;
  const lists = guidesFor(section, sub);
  const guides = (inst.guides ?? []).filter((g) => lists.includes(g.list));
  return (
    <>
      {section === "utility" && sub === "obs" && (
        <>
          <RigPanel note={note} />
          <p className="text-xs text-muted">Other sources: <a href="/overlay" className="text-body-dim underline hover:text-strong">the overlay directory</a> (chat, the credit line); alerts, the support bar and the other overlays: <button type="button" className="text-body-dim underline hover:text-strong" onClick={() => go("utility/overlays")}>Utility → Overlays</button>.</p>
        </>
      )}
      {section === "platforms" && sub === "discord" && <DiscordNote view={inst} />}
      {guides.length > 0 && <SetupGuides guides={guides} />}
      <KeyCards view={inst} groups={keyGroupsFor(section, sub, inst.ownerPlugin !== false)} onChanged={loadInst} note={note} placeLabel={item.label} />
    </>
  );
}
