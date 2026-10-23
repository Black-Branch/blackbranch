"use client";

// The setup guides above a tab's key cards: each setup list's steps — what to do at the provider,
// the values to paste there for THIS install — in the setup pages' own words (one list). The
// fields themselves are the cards below; their Test buttons run the same checks.

import SetupStepGuide from "@/app/components/SetupStepGuide";
import type { InstanceView } from "@/app/lib/instanceAdminView";

type Guide = NonNullable<InstanceView["guides"]>[number];

export default function SetupGuides({ guides }: { guides: Guide[] }) {
  return (
    <>
      {guides.map((g) => {
        if (!g.page) return null;
        const off = g.on === false;
        return (
          <section key={g.list} className="rounded-xl border border-edge bg-surface-1 p-4 space-y-3" data-guide={g.list}>
            <div className="space-y-0.5">
              <h2 className="text-sm font-semibold text-body">How to set up {g.page.label}</h2>
              <p className="text-xs text-secondary">{g.page.description}</p>
              {off && <p className="text-xs text-amber-300">Switched off. Switch it on on this page to use it; the steps are below for when you do.</p>}
            </div>
            <details className="space-y-3">
              <summary className="cursor-pointer text-xs text-muted">Show the {g.page.steps.length} step{g.page.steps.length === 1 ? "" : "s"}</summary>
              <div className="space-y-4 pt-2">
                {g.page.steps.map((s) => (
                  <div key={s.id} className="space-y-1 border-t border-edge pt-3 first:border-t-0 first:pt-0">
                    <SetupStepGuide step={s} />
                    {s.fields.length > 0 && <p className="text-2xs text-muted">Fill in below: {s.fields.map((f) => f.label).join(", ")}.</p>}
                  </div>
                ))}
              </div>
            </details>
          </section>
        );
      })}
    </>
  );
}
