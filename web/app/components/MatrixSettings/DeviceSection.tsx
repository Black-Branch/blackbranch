"use client";

import { useState } from "react";
import type { MatrixSettingsState } from "@/app/lib/useMatrixSettings";
import { LoadingState } from "../Spinner";

type Props = Pick<
  MatrixSettingsState,
  | "sorted"
  | "removing"
  | "removeErrors"
  | "removeDevice"
  | "verifyPhase"
  | "startOutgoing"
  | "currentDeviceId"
  | "accountUrl"
>;

function relativeDate(ts: number): string {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function DeviceSection(p: Props) {
  // Staleness reference point, fixed at mount (30-day cutoff doesn't need live ticking).
  const [now] = useState(() => Date.now());
  return (
    <div className="px-3 py-2.5">
      <p className="text-3xs uppercase tracking-wide text-muted mb-2">Signed-in devices</p>

      {p.sorted === null ? (
        <LoadingState />
      ) : p.sorted.length === 0 ? (
        <p className="text-xs text-muted">No devices found.</p>
      ) : (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {p.sorted.map((d) => {
            const isCurrent = d.device_id === p.currentDeviceId;
            const name = d.display_name || d.device_id;
            const isStale =
              !isCurrent &&
              d.last_seen_ts != null &&
              now - d.last_seen_ts > 30 * 24 * 60 * 60 * 1000;

            return (
              <div key={d.device_id} className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-xs text-body font-medium truncate">{name}</p>
                    {d.verified === true && (
                      <span className="text-3xs px-1 py-px rounded bg-green-400/10 border border-green-400/20 text-green-400 shrink-0">
                        verified
                      </span>
                    )}
                    {d.verified === false && (
                      <span className="text-3xs px-1 py-px rounded bg-surface-1 border border-edge text-muted shrink-0">
                        unverified
                      </span>
                    )}
                    {isStale && (
                      <span className="text-3xs px-1 py-px rounded bg-yellow-400/10 border border-yellow-400/20 text-yellow-500 shrink-0">
                        stale
                      </span>
                    )}
                  </div>
                  <p className="text-3xs text-muted mt-0.5">
                    {isCurrent
                      ? "This browser"
                      : d.last_seen_ts
                      ? `Last seen ${relativeDate(d.last_seen_ts)}`
                      : d.device_id}
                  </p>
                </div>

                {isCurrent ? (
                  <span className="text-3xs px-1.5 py-0.5 rounded bg-surface-2 text-muted shrink-0 mt-0.5">
                    Current
                  </span>
                ) : d.verified === false && p.verifyPhase === "idle" ? (
                  <button
                    onClick={() => p.startOutgoing(d.device_id, name)}
                    className="text-3xs px-1.5 py-0.5 rounded bg-yellow-400/10 hover:bg-yellow-400/20 border border-yellow-400/20 text-yellow-400 hover:text-yellow-300 transition-colors shrink-0 mt-0.5"
                  >
                    Verify
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {p.accountUrl && (
        <button
          onClick={() =>
            window.open(p.accountUrl!, "mx-account", "width=960,height=700,left=200,top=100")
          }
          className="mt-3 w-full text-xs px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-edge text-secondary hover:text-body transition-colors text-left"
        >
          Manage sessions at {new URL(p.accountUrl).hostname} →
        </button>
      )}
    </div>
  );
}
