import type { CSSProperties } from "react";
import { COUNTER_SHOW_WITHIN } from "@/app/lib/chatLimits";

/**
 * "N left", shown only as the writer approaches the limit. Negative once
 * past it (a draft can outlive a limit that shrank under it — switching to
 * TTS mode, lowering a donation) — the number then tells the truth instead
 * of the box silently eating text. Red at zero and below.
 */
export function CharCounter({
  length,
  max,
  showWithin = COUNTER_SHOW_WITHIN,
  className = "",
  style,
}: {
  length: number;
  max: number;
  showWithin?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const left = max - length;
  if (left > showWithin) return null;
  return (
    <span
      aria-live="polite"
      title={`${left} characters left`}
      className={`tabular-nums ${left <= 0 ? "text-red-400" : "text-body-dim"} ${className}`}
      style={style}
    >
      {left}
    </span>
  );
}
