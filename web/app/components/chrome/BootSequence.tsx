// web/app/components/chrome/BootSequence.tsx
"use client";

// The boot sequence: the readiness view of
// the subsystems a surface composes, rendered as a rail of stage marks —
// "Loading Matrix… Preparing encryption…", staged and animated,
// never a bare spinner. What moves: the ACTIVE mark pulses (opacity + scale,
// the compositor's), and a mark's fill eases on the house token when its
// stage completes. A failed stage renders its reason and, when the host
// can retry, a Try again control — a stage is never silently stuck.
//
// Chrome owns this so every loading surface — the community pane, the
// encryption section, a window's in-body placeholder (Window.tsx `loading`),
// the DM window — is the same sequence. Consumers import it from the
// barrel only (check-chrome.mjs).
import { useReadiness } from "@/app/lib/useReadiness";
import { summarizeReadiness } from "@/app/lib/readiness";

export type BootSequenceProps = {
  /** Readiness keys to compose, in display order — e.g. ["matrix", "emotes"]. A module-level constant. */
  keys: readonly string[];
  /** What is being prepared: the eyebrow, and the accessible summary's subject. */
  label: string;
  /** Wired to the failed stage's Try again control; without it a failure renders with no control. */
  onRetry?: () => void;
  /** Inline hosts (a settings section): no eyebrow, no padding. */
  compact?: boolean;
};

export function BootSequence({ keys, label, onRetry, compact = false }: BootSequenceProps) {
  const view = useReadiness(keys);
  const sum = summarizeReadiness(view);
  const summary =
    sum.phase === "error" ? `${label}: ${sum.failed?.label ?? "a stage"} failed`
    : sum.phase === "ready" ? `${label} ready`
    : `${label}: ${sum.active?.label ?? "waiting"}`;
  return (
    <div className="chrome-boot" role="status" aria-live="polite" data-phase={sum.phase} data-compact={compact ? "" : undefined}>
      <span className="sr-only">{summary}</span>
      {!compact && <p className="chrome-boot-eyebrow" aria-hidden="true">{label}</p>}
      <ol className="chrome-boot-list" aria-hidden="true">
        {view.map((s) => (
          <li key={`${s.key}/${s.id}`} className="chrome-boot-stage" data-status={s.status}>
            <span className="chrome-boot-mark" />
            <span className="chrome-boot-label">{s.label}</span>
            {s.status === "error" && s.error && <span className="chrome-boot-detail">{s.error}</span>}
          </li>
        ))}
      </ol>
      {sum.phase === "error" && onRetry && (
        <button type="button" className="chrome-boot-retry" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}
