"use client";

import { chatFontCalc } from "@/app/lib/chatFont";
import { CaretUp } from "@phosphor-icons/react/dist/ssr";

// ─── Forum vote control ──────────────────────────────────────────────────────

// Reddit-style colors: upvote orange, downvote periwinkle.
const VOTE_UP = "#ff4500";
const VOTE_DOWN = "#7193ff";

// Compact score formatting (1200 → "1.2k", 13000 → "13k").
function formatScore(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) {
    const k = n / 1000;
    return (Math.abs(k) < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)) + "k";
  }
  return String(n);
}

// Horizontal up/down vote group for forum posts and comments (Reddit-new style):
// a subtle rounded pill — up-chevron · score · down-chevron. The active arrow +
// score color by the caller's own vote. Clicks stopPropagation so voting inside a
// clickable post card doesn't open the post. `disabled` = own content (no
// self-voting) → read-only.
// Hoisted arrow button (defining it inside ForumVoteControl would recreate the
// component type every render and remount the buttons).
function VoteArrow({
  dir,
  myVote,
  onVote,
  disabled,
}: {
  dir: -1 | 1;
  myVote: -1 | 1 | null;
  onVote: (direction: -1 | 1) => void;
  disabled: boolean;
}) {
  const active = myVote === dir;
  const color = active ? (dir === 1 ? VOTE_UP : VOTE_DOWN) : undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onVote(dir); }}
      title={disabled ? "You can't vote on your own post" : dir === 1 ? "Upvote" : "Downvote"}
      className={`flex items-center justify-center rounded-full transition-colors ${
        disabled
          ? "text-muted cursor-default"
          : active
            ? "hover:bg-surface-3"
            : "text-secondary hover:bg-surface-3"
      }`}
      style={{ width: "1.5em", height: "1.5em", color }}
      onMouseEnter={disabled ? undefined : (e) => { if (!active) e.currentTarget.style.color = dir === 1 ? VOTE_UP : VOTE_DOWN; }}
      onMouseLeave={disabled ? undefined : (e) => { if (!active) e.currentTarget.style.color = ""; }}
    >
      <CaretUp size="0.95em" weight="bold" style={{ transform: dir === -1 ? "rotate(180deg)" : undefined }} />
    </button>
  );
}

export function ForumVoteControl({
  score,
  myVote,
  onVote,
  disabled = false,
  size = "md",
  loaded = true,
}: {
  score: number;
  myVote: -1 | 1 | null;
  onVote: (direction: -1 | 1) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /** When false, the score is still loading — show a placeholder, not a "0". */
  loaded?: boolean;
}) {
  const em = size === "sm" ? 0.8 : 0.9;
  const scoreColor = myVote === 1 ? VOTE_UP : myVote === -1 ? VOTE_DOWN : "#d4d4d8";
  return (
    <div
      className="inline-flex items-center rounded-full bg-surface-1"
      style={{ fontSize: chatFontCalc(em) }}
    >
      <VoteArrow dir={1} myVote={myVote} onVote={onVote} disabled={disabled} />
      <span
        className="tabular-nums font-semibold text-center select-none"
        style={{ minWidth: "1.35em", color: loaded ? scoreColor : "#52525b" }}
      >
        {loaded ? formatScore(score) : "·"}
      </span>
      <VoteArrow dir={-1} myVote={myVote} onVote={onVote} disabled={disabled} />
    </div>
  );
}
