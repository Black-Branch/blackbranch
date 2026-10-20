"use client";

import { CHAT_FONT } from "@/app/lib/chatFont";
import { useEffect, useState, type CSSProperties } from "react";
import { postJsonOrThrow, HttpError } from "@/app/lib/http";
import { keepFocus } from "@/app/lib/keepFocus";
import { PLATFORM_COLORS } from "./PlatformIcon";

// Interactive poll chat card (system: "poll"). The card's `poll` payload is
// swapped in place by the pollUpdate/pollEnd WS frames (useChatMessages), so
// this component just renders whatever state it's handed and posts votes.
// Numbered options double as the instructions for platform chatters, who vote
// by typing the number in their own chat.

export type { PollState } from "@/app/lib/pollState";
import type { PollState } from "@/app/lib/pollState";

const ACCENT = PLATFORM_COLORS.native ?? "#a5c8f7";
const WIN = "#7dd9a8";

function fmtRemaining(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function PollCard({
  poll,
  canModerate,
  signedIn,
}: {
  poll: PollState;
  canModerate: boolean;
  signedIn: boolean;
}) {
  // Client-side memory of the viewer's own vote (optimistic highlight — the
  // server holds the authoritative upsert).
  const [myVote, setMyVote] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 1s countdown tick while active (setState inside the interval callback).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const active = poll.status === "active" && poll.endsAt > nowTick;
  useEffect(() => {
    if (poll.status !== "active") return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [poll.status]);

  async function vote(n: number) {
    if (!active || busy) return;
    if (!signedIn) {
      setNotice("Sign in to vote — or type the number in your platform's chat");
      return;
    }
    setBusy(true);
    setNotice(null);
    const prev = myVote;
    setMyVote(n);
    try {
      await postJsonOrThrow("/api/poll/vote", { optionN: n });
    } catch (e) {
      setMyVote(prev);
      setNotice(e instanceof HttpError && e.status === 409 ? "Poll just closed" : "Vote failed — try again");
    } finally {
      setBusy(false);
    }
  }

  async function modAction(action: "end" | "cancel" | "extend") {
    if (busy) return;
    setBusy(true);
    try {
      await postJsonOrThrow("/api/poll/end", { action, addSec: 60 });
    } catch {
      setNotice("Action failed");
    } finally {
      setBusy(false);
    }
  }

  const done = poll.status !== "active";
  // Match the user's chat-settings font like the monetization cards do
  // (size/family/weight/line-height + the Shadow toggle, which inherits).
  const font: CSSProperties = {
    fontSize: CHAT_FONT,
    fontFamily: "var(--chat-font-family, inherit)",
    fontWeight: "var(--chat-font-weight, 400)" as CSSProperties["fontWeight"],
    lineHeight: "var(--chat-line-height, 1.4)",
    textShadow: "var(--chat-shadow)",
  };
  return (
    // `touch-no-select` because a poll REPLACES a message row (there is no
    // ChatMessage wrapper around it), so it was the one thing in the timeline
    // that still started a text selection under a touch-and-hold — R-16.
    <div className="px-2 touch-no-select" style={{ paddingTop: "var(--chat-msg-gap, 1px)" }}>
      <div
        className="rounded-md px-2.5 py-1.5"
        style={{ ...font, background: `${ACCENT}14`, boxShadow: `inset 0 0 0 1px ${ACCENT}4d` }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-bold text-heading min-w-0 break-words">{poll.question}</span>
          <span
            className="shrink-0 tabular-nums font-semibold"
            style={{ fontSize: "var(--text-chat-md)", color: done ? (poll.status === "cancelled" ? "#f87171" : WIN) : ACCENT }}
          >
            {done ? (poll.status === "cancelled" ? "Cancelled" : "Final") : fmtRemaining(poll.endsAt - nowTick)}
          </span>
        </div>
        {poll.createdByName && (
          <div className="text-muted" style={{ fontSize: "var(--text-chat-sm)" }}>
            started by {poll.createdByName}
          </div>
        )}

        <div className="mt-1 space-y-0.5">
          {poll.options.map((o) => {
            const t = poll.tallies?.[o.n] ?? 0;
            const pct = poll.total > 0 ? Math.round((t / poll.total) * 100) : 0;
            const won = poll.status === "ended" && poll.winner === o.n;
            const mine = myVote === o.n;
            return (
              <button
                key={o.n}
                type="button"
                disabled={!active || busy}
                onClick={() => vote(o.n)}
                onMouseDown={keepFocus}
                className={`relative w-full overflow-hidden rounded text-left transition-colors ${active ? "hover:bg-surface-2 cursor-pointer" : "cursor-default"}`}
                style={{ background: "rgba(255,255,255,0.05)" }}
                title={active ? `Vote ${o.n}` : undefined}
              >
                <span
                  className="absolute inset-y-0 left-0 transition-[width] duration-(--anim-slower)"
                  style={{ width: `${pct}%`, background: won ? `${WIN}45` : `${ACCENT}33` }}
                />
                <span className="relative flex items-center gap-2 px-1.5 py-0.5">
                  <span
                    className="flex-none flex items-center justify-center rounded font-bold"
                    style={{
                      width: "1.35em", height: "1.35em",
                      fontSize: "var(--text-chat-sm)",
                      background: mine ? ACCENT : "rgba(255,255,255,0.12)",
                      color: mine ? "#0c0c10" : "#e4e4e7",
                    }}
                  >
                    {o.n}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-heading">{o.text}</span>
                  <span className="flex-none tabular-nums font-semibold text-body">{pct}%</span>
                  <span className="flex-none tabular-nums text-muted" style={{ fontSize: "var(--text-chat-sm)" }}>
                    ({t})
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-muted" style={{ fontSize: "var(--text-chat-xs)" }}>
            {active ? "Tap an option — or type the number in your platform's chat" : `${poll.total} vote${poll.total === 1 ? "" : "s"}`}
          </span>
          {canModerate && active && (
            <span className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => modAction("extend")} onMouseDown={keepFocus} disabled={busy}
                className="px-1.5 py-0.5 rounded text-secondary hover:text-strong hover:bg-surface-3 transition-colors"
                style={{ fontSize: "var(--text-chat-xs)" }} title="Extend by 1 minute">+1m</button>
              <button type="button" onClick={() => modAction("end")} onMouseDown={keepFocus} disabled={busy}
                className="px-1.5 py-0.5 rounded text-secondary hover:text-strong hover:bg-surface-3 transition-colors"
                style={{ fontSize: "var(--text-chat-xs)" }} title="End now (show results)">End</button>
              <button type="button" onClick={() => modAction("cancel")} onMouseDown={keepFocus} disabled={busy}
                className="px-1.5 py-0.5 rounded text-muted hover:text-red-300 hover:bg-red-900/30 transition-colors"
                style={{ fontSize: "var(--text-chat-xs)" }} title="Cancel (no results)">✕</button>
            </span>
          )}
        </div>
        {notice && (
          <div className="mt-1 text-amber-300/90" style={{ fontSize: "var(--text-chat-sm)" }}>
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
