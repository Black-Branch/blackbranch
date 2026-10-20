"use client";

import { useState } from "react";
import { useBadges } from "@/app/lib/BadgesContext";
import { postJson } from "@/app/lib/http";

// Badge slot row (unlock + equip, v60). Shows a fixed row of slot positions:
// filled/empty unlocked slots + greyed LOCKED slots (capacity not yet unlocked — a
// subscription unlocks one). The fixed mod badge sits off-slot. When `editable`
// (the signed-in user viewing their own slots), an unlocked badge from the catalog
// can be equipped into a selected unlocked slot; otherwise it's a read-only view.
export default function BadgeSlots({ matrixId, editable = false }: { matrixId: string; editable?: boolean }) {
  const badges = useBadges();
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const u = badges.perUser[matrixId];
  const slotCount = u?.slotCount ?? 0;
  const equipped = u?.equipped ?? [];
  const unlocked = new Set(u?.unlocked ?? []);
  const modBadge = u?.isMod && badges.modBadgeId != null ? badges.byId[badges.modBadgeId] : null;
  // Equippable catalog = everything except the fixed mod badge (which is off-slot).
  const equippable = badges.catalog.filter((b) => b.id !== badges.modBadgeId);

  async function equip(slotIndex: number, badgeId: number | null) {
    if (busy) return;
    setBusy(true);
    setErr("");
    const res = await postJson("/api/badges/equip", { slotIndex, badgeId }).catch(() => null);
    setBusy(false);
    if (!res || !res.ok) setErr("Couldn’t change that badge — try again.");
    badges.refresh();
  }

  return (
    <div className="space-y-2">
      {/* Slot row */}
      <div className="flex items-center gap-1.5">
        <span className="text-3xs uppercase tracking-wide text-muted shrink-0 mr-0.5">Badges</span>
        {modBadge && (
          <img
            src={modBadge.imageUrl}
            alt={modBadge.name}
            title={`${modBadge.name} (mod)`}
            className="h-5 w-auto rounded-sm ring-1 ring-emerald-500/40"
          />
        )}
        {Array.from({ length: badges.maxSlots }).map((_, i) => {
          const isUnlocked = i < slotCount;
          const bid = equipped[i] ?? null;
          const def = bid != null ? badges.byId[bid] : null;
          const isSel = editable && isUnlocked && selected === i;
          if (!isUnlocked) {
            return (
              <span
                key={i}
                title="Locked slot — subscribe to unlock a badge slot"
                className="h-6 w-6 rounded flex items-center justify-center bg-surface-1 text-muted text-2xs select-none"
              >
                🔒
              </span>
            );
          }
          return (
            <button
              key={i}
              type="button"
              disabled={!editable}
              onClick={() => setSelected(i)}
              title={editable ? (def ? `${def.name} — click to select this slot` : "Empty slot — click to select") : def?.name}
              className={`h-6 w-6 rounded flex items-center justify-center transition-colors ${
                isSel ? "bg-surface-4 ring-1 ring-edge-bright" : "bg-surface-1 hover:bg-surface-3"
              } ${editable ? "cursor-pointer" : "cursor-default"}`}
            >
              {def ? (
                <img src={def.imageUrl} alt={def.name} className="h-4 w-auto" />
              ) : (
                <span className="text-muted text-sm leading-none">＋</span>
              )}
            </button>
          );
        })}
        {editable && equipped[selected] != null && selected < slotCount && (
          <button
            type="button"
            onClick={() => equip(selected, null)}
            disabled={busy}
            title="Clear this slot"
            className="text-2xs text-muted hover:text-red-300 transition-colors ml-0.5"
          >
            clear
          </button>
        )}
      </div>

      {/* Catalog — greyed unless the badge is unlocked for this user. Own-card only. */}
      {editable && equippable.length > 0 && (
        // Scrolls rather than grows — the catalog gets longer every time a
        // badge is added, and it sits in a card and a settings page.
        <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto overscroll-contain">
          {equippable.map((b) => {
            const isUnlocked = unlocked.has(b.id);
            const canEquip = editable && isUnlocked && slotCount > 0;
            return (
              <button
                key={b.id}
                type="button"
                disabled={!canEquip || busy}
                onClick={() => canEquip && equip(selected, b.id)}
                title={
                  isUnlocked
                    ? editable ? `Equip "${b.name}" into slot ${selected + 1}` : b.name
                    : `${b.name} — locked`
                }
                className={`flex items-center gap-1 px-1.5 py-1 rounded text-2xs transition-colors ${
                  isUnlocked ? "bg-surface-2 text-body" : "bg-surface-1 text-muted"
                } ${canEquip ? "hover:bg-surface-3 cursor-pointer" : "cursor-default"}`}
              >
                <img
                  src={b.imageUrl}
                  alt=""
                  className={`h-3.5 w-auto ${isUnlocked ? "" : "opacity-40 grayscale"}`}
                />
                <span className="truncate max-w-[80px]">{b.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {editable && slotCount === 0 && (
        <p className="text-3xs text-muted">Subscribe to unlock a badge slot.</p>
      )}
      {err && <p role="alert" className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
