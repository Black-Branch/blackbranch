"use client";
// The Stream tab's Settings row (#247): direct jumps into the Admin window at the places a streamer
// reaches for on stream — the timer, the support bar, the effects and OBS. The /timer and /bar chat
// commands are untouched; this is the way to their configuration that was hard to find.
import { AdminJump } from "./AdminJump";
import { card } from "./StreamCharts";

/** Each jump's Admin Panel place, in the order the row shows them.
 *  @test-only exported so streamTab.render.test.ts proves every place exists in the Admin Panel's
 *  rail; StreamSettings below is its runtime reader. */
export const SETTINGS_JUMPS = [
  { place: "utility/timer", label: "Timer" },
  { place: "utility/bar", label: "Support bar" },
  { place: "utility/effects", label: "Effects" },
  { place: "utility/obs", label: "OBS" },
] as const;

const chipLink = "inline-flex h-6 items-center rounded-md border border-edge bg-surface-2 px-2 text-xs text-body hover:bg-surface-3";

export function StreamSettings() {
  return (
    // One line on a phone when it fits: the title and the jumps share a row, the jumps wrap under it.
    <section className={`${card} flex flex-wrap items-center gap-x-2 gap-y-1.5`} data-section="settings">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-secondary">Settings</h3>
      <nav aria-label="Stream settings" className="flex flex-wrap gap-1">
        {SETTINGS_JUMPS.map((j) => <AdminJump key={j.place} place={j.place} className={chipLink}>{j.label}</AdminJump>)}
      </nav>
    </section>
  );
}
