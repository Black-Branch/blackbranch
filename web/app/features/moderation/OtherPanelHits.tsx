"use client";

// The other panel's places a search matched: one line of buttons under the
// search; choosing one opens that panel on that place. Shared by both panels (the Admin Panel
// reaches it through this feature's public API).
import type { PanelPlace } from "@/app/lib/panelSearch";

export default function OtherPanelHits({ title, hits, onOpen }: { title: string; hits: readonly PanelPlace[]; onOpen: (hit: PanelPlace) => void }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted" aria-label={title} role="group">
      <span>{title}:</span>
      {hits.slice(0, 8).map((h) => (
        <button key={`${h.panel}:${h.id}`} type="button" onClick={() => onOpen(h)}
          className="rounded-md border border-edge bg-surface-1 px-2 py-0.5 text-body-dim hover:bg-surface-2 hover:text-strong">
          {h.group ? `${h.group} · ${h.label}` : h.label} ↗
        </button>
      ))}
    </div>
  );
}
