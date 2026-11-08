import type { ReactNode } from "react";

/** The quiet connection pill, centred at the top of the nearest positioned
 *  ancestor: live chat's "Reconnecting to chat…" and the community's
 *  "Reconnecting to the community…". role=status, never alert — a connection
 *  blip is context, not an interruption. */
export function StatusPill({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      // Opaque and one line, like PausedPill: it sits over a full timeline's text.
      className="absolute top-2 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap rounded-full border border-edge bg-raised/95 px-3 py-1 text-xs text-body-dim shadow-lg"
    >
      {children}
    </div>
  );
}
