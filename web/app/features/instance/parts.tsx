// Pieces the Admin Panel's sections share: the class names, the "ago" formatter and the service
// strip. Internal to this feature — reached only by its own panels.
// Fields and buttons follow docs/DESIGN-STANDARD.md: 24px controls, the one FIELD style.

"use client";

import { useState, type ReactNode } from "react";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { FIELD } from "@/app/components/SettingsControls";
import { lsGetJSON, lsSetJSON } from "@/app/lib/safeLocalStorage";
import { serviceName } from "./adminLayout";

type Proc = InstanceView["processes"][number];

export const card = "rounded-xl border border-edge bg-surface-1 p-4";
export const h2 = "text-sm font-semibold text-body";
export const h3 = "text-xs font-semibold text-body-dim";
export const btn = "h-6 shrink-0 px-2.5 rounded-md border border-edge bg-surface-2 hover:bg-surface-3 text-xs font-medium text-body transition-colors outline-none focus-visible:ring-1 focus-visible:ring-edge-bright disabled:opacity-40";
export const input = `${FIELD} min-w-0 flex-1 basis-32 px-2 text-xs placeholder:text-muted disabled:opacity-60`;
export const chip = "inline-flex items-center gap-1 rounded-md border border-edge px-1.5 py-0.5 text-2xs leading-4";

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** One line per service: is it answering, has it loaded the saved settings. */
export function ProcessStrip({ procs }: { procs: Proc[] }) {
  return (
    <section className={`${card} flex flex-wrap gap-2`} aria-label="Service state">
      {procs.map((p) => {
        const bad = !p.reachable || !p.loaded || !!p.failingSince;
        return (
          <span key={p.package} className={`${chip} ${bad ? "text-amber-300" : "text-secondary"}`}>
            <span className="font-medium text-body">{serviceName(p.package)}</span>
            {!p.reachable ? "not reporting" : !p.loaded ? "saved settings not loaded — using server settings and defaults"
              : p.failingSince ? `out of date since ${ago(p.failingSince)}` : `loaded ${ago(p.loadedAt)}`}
            {p.package === "stream-api" && p.masterKey && p.masterKey !== "ok" && (
              <span className="text-amber-300">· encryption key {p.masterKey}</span>
            )}
          </span>
        );
      })}
    </section>
  );
}

const FOLD_KEY = "bb_admin_details";

/** A row's Details fold: closed unless this row's was left open — the
 *  open ones are remembered by id. The panel renders after its data loads, never on the server,
 *  so reading storage in the initializer cannot mismatch a server render. */
export function Fold({ id, summary = "Details", children }: { id: string; summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => lsGetJSON<string[]>(FOLD_KEY, []).includes(id));
  return (
    <details open={open} className="mt-1.5" onToggle={(e) => {
      const now = e.currentTarget.open;
      if (now === open) return;
      setOpen(now);
      const ids = lsGetJSON<string[]>(FOLD_KEY, []).filter((x) => x !== id);
      lsSetJSON(FOLD_KEY, now ? [...ids, id] : ids);
    }}>
      <summary className="cursor-pointer select-none text-2xs text-muted hover:text-secondary">{summary}</summary>
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </details>
  );
}
