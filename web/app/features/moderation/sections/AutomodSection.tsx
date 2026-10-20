"use client";

// The Automod section of the mod panel, extracted from ModPanel.tsx.
// Internal to the `moderation` feature — nothing outside can import it.

import { useState } from "react";
import { LoadingState } from "@/app/components/Spinner";
import { siteName } from "@/app/lib/siteName";
import { card, h2, btn, timeAgo } from "../shared";
import { useAutomodQueue, isDismissOnly, degradedLine } from "@/app/lib/useAutomodQueue";
import { isNativePlatform } from "@/app/lib/nativePlatform";

// Fetching + resolving live in useAutomodQueue, shared with the inline chat
// bar (AutomodHoldBar). Both surfaces can be on screen at once, and a second
// copy of this logic would mean two polls AND two views that disagree about
// what is still pending — offering Allow on something the other already
// resolved. One store, one queue.

// ─── Automod queue ────────────────────────────────────────────────────────────

export default function AutomodSection({ note }: { note: (m: string) => void }) {
  // Always enabled: this section only ever renders inside the mod panel.
  const { held, automod, resolve: resolveHold } = useAutomodQueue(true);
  const degraded = degradedLine(automod);
  const [busy, setBusy] = useState<number | null>(null);

  async function resolve(id: number, action: "allow" | "deny") {
    setBusy(id);
    const r = await resolveHold(id, action);
    if (r === "expired") note("That hold already expired on Twitch.");
    else if (r === "failed") note("Couldn't resolve that — try again.");
    setBusy(null);
  }

  return (
    <section className={card}>
      {/* Not "(Twitch)" — since v84 this queue also carries our own blocklist /
          account_age / link_gate rows, which have no 5-minute deadline. */}
      <h2 className={h2}>Automod queue</h2>
      {degraded && <p role="status" className="mb-2 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs text-amber-300">{degraded}</p>}
      {held === null ? (
        <LoadingState />
      ) : held.length === 0 ? (
        <p className="text-xs text-muted">Nothing held. Messages the automod holds back wait here for a mod to allow or remove (Twitch automod holds expire after ~5 minutes).</p>
      ) : (
        <ul className="space-y-2">
          {held.map((m) => (
            <li key={m.id} className="flex items-start gap-3 rounded-lg bg-surface-1 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-secondary">
                  <span className="text-body font-medium">{m.userName ?? m.userLogin ?? m.msgId ?? "unknown"}</span>
                  {m.category && <span className="ml-2 text-amber-400/90">{m.category}{m.level != null ? ` L${m.level}` : ""}</span>}
                  {m.source === "ai" && (
                    <span className="ml-2 text-violet-300/90" title={m.matchedTerm ? `The model's reason: ${m.matchedTerm}` : undefined}>
                      AI{m.confidence != null ? ` · ${Math.round(m.confidence * 100)} %` : ""}{m.status === "flagged" ? (isNativePlatform(m.platform) ? " · already posted here (checked late)" : ` · already posted on ${m.platform ?? "its platform"}`) : ""}
                    </span>
                  )}
                  {/* Same disclosure as the inline bar: which rule fired is the
                      evidence for changing the blocklist, and the panel is
                      where the list gets managed. */}
                  {m.status === "blocked" && (
                    <span className="ml-2 text-red-400/90 font-semibold">
                      blocked{m.matchedTerm ? ` · "${m.matchedTerm}"` : ""}
                    </span>
                  )}
                  {/* The hold is only the platform COPY — Deny also removes the
                      already-posted site original. */}
                  {m.siteMsgId != null && (
                    <span className="ml-2 text-sky-400/90"
                      title={`Copy of a ${siteName()} message that already posted. Deny also removes the original and its other platform copies.`}>
                      cross-post
                    </span>
                  )}
                  <span className="ml-2 text-muted">{timeAgo(m.heldAt)}</span>
                </div>
                <div className="text-sm text-body-dim break-words">{m.text}</div>
              </div>
              {/* A 'blocked' row (severity-4 hit) was NEVER delivered — there is
                  no message waiting to publish, so Allow would be a button that
                  reads as "publish this slur" and does nothing. Dismiss-only,
                  exactly like the inline bar (which had this right first). */}
              <div className="shrink-0 flex gap-1.5">
                {isDismissOnly(m) ? (
                  <button className={btn} disabled={busy === m.id}
                    title="Clear from the review queue. Does not punish — use the user card to ban or time out."
                    onClick={() => resolve(m.id, "deny")}>Dismiss</button>
                ) : (
                  <>
                    <button className={`${btn} hover:!bg-emerald-900/50`} disabled={busy === m.id}
                      onClick={() => resolve(m.id, "allow")}>Allow</button>
                    <button className={`${btn} hover:!bg-red-900/50`} disabled={busy === m.id}
                      onClick={() => resolve(m.id, "deny")}>Deny</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
