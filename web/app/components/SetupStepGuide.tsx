"use client";

// One step of a setup list, as read — its title, plain explanation, the provider's own pages and
// the values to paste there, computed for this install (app/lib/setup/setupPages.ts). The setup
// pages draw it above the step's fields; the Admin Panel draws it above the same keys' cards, so
// both show one list's words (config/modules.mjs `setup`, config/setup-core.mjs).

import { useState } from "react";
import type { SetupStepView } from "@/app/lib/setup/setupPages";

const btn = "h-6 shrink-0 px-2.5 rounded-md border border-edge bg-surface-2 hover:bg-surface-3 text-xs font-medium text-body transition-colors outline-none focus-visible:ring-1 focus-visible:ring-edge-bright";

/** Copy, and say so: a paste value is copied into another site's form, so the press must be seen. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState<"copied" | "failed" | null>(null);
  const copy = () => {
    const p = navigator.clipboard?.writeText(value);
    if (!p) { setDone("failed"); return; }
    p.then(() => setDone("copied"), () => setDone("failed"))
      .finally(() => setTimeout(() => setDone(null), 1800));
  };
  return (
    <button type="button" className={`${btn} w-20`} onClick={copy} aria-label={`Copy ${label}`} aria-live="polite">
      {done === "copied" ? "Copied" : done === "failed" ? "Not copied" : "Copy"}
    </button>
  );
}

export default function SetupStepGuide({ step }: { step: SetupStepView }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-body">{step.title}</h3>
        <span className="text-2xs text-muted">{step.need}</span>
      </div>
      <p className="text-sm text-secondary">{step.explain}</p>
      {step.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="block text-xs text-body underline">{l.label} ↗</a>)}
      {step.paste.map((p) => (
        <div key={p.label} className="space-y-0.5">
          <p className="text-2xs text-muted">{p.label}</p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-strong break-all select-all">{p.value}</code>
            <CopyButton value={p.value} label={p.label} />
          </div>
        </div>
      ))}
    </div>
  );
}
