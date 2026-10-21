"use client";

// One step of a setup list, as read — its title, plain explanation, the provider's own pages and
// the values to paste there, computed for this install (app/lib/setup/setupPages.ts). The setup
// pages draw it above the step's fields; the Admin Panel draws it above the same keys' cards, so
// both show one list's words (config/modules.mjs `setup`, config/setup-core.mjs) and the pages' own
// help on top (app/lib/setup/setupExtras.ts): a short first sentence, the rest folded.

import { useState } from "react";
import type { SetupStepView } from "@/app/lib/setup/setupPages";

// Opaque, not a translucent surface: a browser theme that makes the page see-through (Zen's) left
// translucent buttons invisible.
const btn = "h-6 shrink-0 px-2.5 rounded-md border border-edge-strong bg-raised hover:bg-control text-xs font-medium text-body transition-colors outline-none focus-visible:ring-1 focus-visible:ring-edge-bright";
const hint = "text-2xs text-muted";

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

/** A long explanation's first sentence, and the rest (folded). A short one stays whole. */
function splitExplain(text: string): { lead: string; rest: string | null } {
  if (text.length <= 200) return { lead: text, rest: null };
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(text);
  return m ? { lead: m[1]!, rest: m[2]! } : { lead: text, rest: null };
}

function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-edge px-2 py-1">
      <summary className="cursor-pointer text-xs font-medium text-body">{title}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}

function PasteLine({ label, value, copy }: { label: string; value: string; copy: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className={hint}>{label}</p>
      <div className="flex gap-2">
        <code className="min-w-0 flex-1 rounded-md border border-edge bg-raised px-2 py-0.5 text-xs text-strong break-all select-all">{value}</code>
        {copy && <CopyButton value={value} label={label} />}
      </div>
    </div>
  );
}

export default function SetupStepGuide({ step }: { step: SetupStepView }) {
  const help = step.help;
  const { lead, rest } = splitExplain(step.explain);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-body">{step.title}</h3>
        <span className="text-2xs text-muted">{step.need}</span>
      </div>
      <p className="text-sm text-secondary">{lead}</p>
      {rest && <Fold title="How, step by step"><p className="text-xs text-secondary">{rest}</p></Fold>}
      {help?.note && <p className="text-xs text-body">{help.note}</p>}
      {help?.later && <p className="text-xs text-body">{help.later}</p>}
      {step.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="block text-xs text-body underline">{l.label} ↗</a>)}
      {step.paste.map((p) => {
        const info = help?.info?.[p.label];
        return <PasteLine key={p.label} label={info ?? p.label} value={p.value} copy={!info} />;
      })}
      {help?.extraPaste?.map((p) => <PasteLine key={p.label} label={p.label} value={p.value} copy />)}
      {help?.more?.map((m) => (
        <Fold key={m.title} title={m.title}>
          <ul className="list-disc space-y-0.5 pl-4">{m.body.map((b) => <li key={b} className="text-xs text-secondary">{b}</li>)}</ul>
        </Fold>
      ))}
    </div>
  );
}
