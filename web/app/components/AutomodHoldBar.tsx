"use client";

// Held-for-review messages, shown INLINE IN CHAT to mods.
//
// Twitch drops an unresolved hold after ~5 minutes, so a queue that renders
// only in the mod panel is a queue nobody sees in time. Design follows from
// that one fact:
//   • it PINS rather than scrolling with the messages — a row that drifts out of
//     view during a busy stream is the failure being prevented
//   • it sits between the messages and the composer, with the other
//     controls, rather than stacked on top of the reading area
//   • it renders NOTHING when the queue is empty, so it costs no attention until
//     it deserves all of it
//   • Allow / Deny are right there; needing to open a panel is what lets holds
//     expire
//   • the countdown is explicit, because "you have 5 minutes" is the whole
//     reason to look now rather than later

import { useEffect, useState } from "react";
import { siteName } from "@/app/lib/siteName";
import { useAutomodQueue, isDismissOnly, degradedLine, type HeldMessage } from "@/app/lib/useAutomodQueue";
import { ShieldWarning } from "@phosphor-icons/react/dist/ssr";
import { NATIVE_PLATFORM } from "@/app/lib/nativePlatform";

/** Twitch's hold window. Matches the 6-minute server-side sweep, minus slack. */
const HOLD_MS = 5 * 60_000;

function secondsLeft(heldAt: string, holdMs: number = HOLD_MS): number {
  return Math.max(0, Math.round((new Date(heldAt).getTime() + holdMs - Date.now()) / 1000));
}

export default function AutomodHoldBar({
  isMod,
  onModerate,
}: {
  isMod: boolean;
  /**
   * Open this person's user card — where ban / timeout / purge and the
   * cross-platform reach actually live.
   *
   * Review exists as much for the PERSON as for the message (it might need a
   * ban), and Allow / Deny / Dismiss are decisions about the MESSAGE only.
   *
   * Deliberately routed to the user card, NOT the mod panel: the panel's
   * target box runs input through `resolveTarget`, which builds
   * `@name:<server>` — right for a site account, wrong for a platform-only
   * chatter, who is precisely the person most likely to appear here. The card
   * already handles both id shapes (matrix, else canonical).
   */
  onModerate?: (who: { matrixId: string | null; canonicalId: string | null; username: string; platform: string }) => void;
}) {
  const { held, automod, pending, resolve } = useAutomodQueue(isMod);
  const degraded = degradedLine(automod);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  // Errors surface IN the bar rather than through a toast: the bar is already
  // the thing the mod is looking at, and chat has no notice channel to borrow.
  const [err, setErr] = useState<string | null>(null);
  // Re-render once a second purely to move the countdowns. Cheap, and only ever
  // mounted for a mod with something actually pending.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [pending]);

  if (!isMod || !held || pending === 0) return null;

  // A 'blocked' row (severity-4 blocklist hit) was NEVER delivered, so Allow and
  // Deny are meaningless for it — there is no message waiting to be published.
  // It is in the queue purely so a mod sees who said it and can act on the
  // person. Rendering the same buttons would invite a click that does nothing,
  // or worse, reads as "Allow will publish this slur".
  // Automod's flagged platform rows are the same: already public, nothing to release.
  const isBlocked = (m: HeldMessage) => isDismissOnly(m);

  const shown: HeldMessage[] = expanded ? held : held.slice(0, 1);

  async function act(m: HeldMessage, action: "allow" | "deny") {
    setBusy(m.id);
    const r = await resolve(m.id, action);
    setBusy(null);
    if (r === "expired") setErr("That hold already expired on Twitch.");
    else if (r === "failed") setErr("Couldn't resolve that — try again.");
    else setErr(null);
  }

  return (
    <div className="shrink-0 border-t border-amber-500/30 bg-amber-950/25">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <ShieldWarning size={14} weight="fill" className="text-amber-400 shrink-0" />
        <span className="text-xs font-semibold text-amber-300">
          {pending} to review
        </span>
        {pending > 1 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto text-2xs text-amber-200/80 hover:text-amber-100 transition-colors"
          >
            {expanded ? "Show less" : `Show all ${pending}`}
          </button>
        )}
      </div>

      {degraded && <p role="status" className="px-3 pb-1 text-2xs text-amber-300">{degraded}</p>}
      {err && <p className="px-3 pb-1 text-2xs text-red-300">{err}</p>}

      <ul className="px-3 pb-2 space-y-1.5">
        {shown.map((m) => {
          // Automod's own holds are dropped after automod.holdExpiry (decision 25) — a real deadline.
          const aiHold = m.source === "ai" && m.status === "pending" && !!automod?.holdExpiry;
          const left = aiHold ? secondsLeft(m.heldAt, (automod?.holdExpiry ?? 0) * 1000) : secondsLeft(m.heldAt);
          return (
            <li key={m.id} className="flex items-start gap-2 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-2xs">
                  <span className="font-medium text-amber-100 truncate">
                    {m.userName ?? m.userLogin ?? "unknown"}
                  </span>
                  {m.category && (
                    <span className="text-amber-300/80 shrink-0">
                      {m.category}{m.level != null ? ` L${m.level}` : ""}
                    </span>
                  )}
                  {/* The hold is only the Twitch COPY — the site's original
                      already posted. Deny reaches through to it (ticket #4);
                      the mod deciding must know the blast radius. */}
                  {m.siteMsgId != null && (
                    <span
                      className="shrink-0 text-sky-300/80"
                      title={`Copy of a ${siteName()} message that already posted. Deny also removes the original and its other platform copies.`}
                    >
                      cross-post
                    </span>
                  )}
                  {/* Say plainly that this one is already dealt with, and which
                      rule caught it — that is what a mod needs to judge whether
                      the term or the person is the problem. */}
                  {isBlocked(m) && (
                    <span className="shrink-0 text-red-300 font-semibold">
                      blocked{m.matchedTerm ? ` · "${m.matchedTerm}"` : ""}
                    </span>
                  )}
                  {/* Under a minute the number turns red — this is the last
                      chance to act before Twitch decides by doing nothing. */}
                  {/* Countdown only where one exists: Twitch drops an
                      unresolved hold after ~5 minutes. Our own rows — ALL of
                      blocklist / account_age / link_gate, not just blocklist —
                      have no deadline (the server sweep only expires
                      source='twitch'), and a fake ticking clock counting down
                      to a permanent "expiring" would imply they expire. */}
                  {m.source === "ai" && (
                    <span className="shrink-0 text-violet-300/80" title={m.matchedTerm ? `The model's reason: ${m.matchedTerm}` : undefined}>
                      AI{m.confidence != null ? ` ${Math.round(m.confidence * 100)} %` : ""}{m.status === "flagged" ? " · already posted" : ""}
                    </span>
                  )}
                  {m.source === "twitch" || aiHold ? (
                    <span className={`ml-auto shrink-0 tabular-nums ${left <= 60 ? "text-red-400" : "text-amber-200/60"}`}>
                      {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expiring"}
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 text-amber-200/40">no deadline</span>
                  )}
                </div>
                <div className="text-xs text-amber-50/90 break-words">{m.text}</div>
              </div>
              <div className="shrink-0 flex gap-1">
                {onModerate && (
                  <button
                    className="text-2xs px-2 py-0.5 rounded border border-edge text-body-dim hover:text-strong hover:bg-surface-2 transition-colors"
                    onClick={() => onModerate({
                      matrixId: m.matrixId ?? null,
                      canonicalId: m.userId ?? null,
                      username: m.userName ?? m.userLogin ?? "unknown",
                      platform: m.platform ?? (m.source === "twitch" ? "twitch" : NATIVE_PLATFORM),
                    })}
                    title="Open this user — ban, timeout, purge, cross-platform reach"
                  >
                    Mod
                  </button>
                )}
                {isBlocked(m) ? (
                  <button
                    className="text-2xs px-2 py-0.5 rounded border border-edge text-secondary hover:text-strong hover:bg-surface-2 transition-colors disabled:opacity-40"
                    disabled={busy === m.id}
                    onClick={() => act(m, "deny")}
                    title="Clear from the review queue. Does not punish — use the user card to ban or time out."
                  >
                    Dismiss
                  </button>
                ) : (
                  <>
                    <button
                      className="text-2xs px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/40 transition-colors disabled:opacity-40"
                      disabled={busy === m.id}
                      onClick={() => act(m, "allow")}
                    >
                      Allow
                    </button>
                    <button
                      className="text-2xs px-2 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-900/40 transition-colors disabled:opacity-40"
                      disabled={busy === m.id}
                      onClick={() => act(m, "deny")}
                    >
                      Deny
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
