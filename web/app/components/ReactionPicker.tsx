"use client";

import { useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { emoteCrossOrigin, lowerResEmoteUrl } from "@/app/lib/emoteRes";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { Segmented } from "@/app/components/chrome";
import { lsSetJSON } from "@/app/lib/safeLocalStorage";
import { Twemoji } from "@/app/lib/twemoji";
import { EMOJI_GROUPS } from "@/app/lib/emojiGroups";
import { clampIntoSpan, visibleViewport } from "@/app/lib/visibleViewport";
import { mxcToDownload } from "@/app/lib/matrixMedia";

// ─── Reaction picker (message tap action) ────────────────────────────────────

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🔥", "👀"];

// The viewer's reaction history: [key, uses] pairs, most recently used first, so a tie in uses
// goes to the more recent by position alone. Read from storage on every call (a string read) and
// parsed only when it changed — rows call this in their render body.
const USES_KEY = "bb_reaction_uses";
/** The previous store: the last keys used, newest first. Read once as a seed (one use each). */
const LEGACY_RECENT_KEY = "bb_recent_reactions";
const USES_CAP = 32;
/** The three quick reactions: the most used, filled from the curated list until there are three. */
const QUICK_COUNT = 3;

type Uses = [string, number][];
let usesCache: { raw: string | null; legacyRaw: string | null; uses: Uses } | null = null;

function parseUses(raw: string | null, legacyRaw: string | null): Uses {
  let v: unknown;
  try { v = JSON.parse(raw ?? legacyRaw ?? "[]"); } catch { return []; }
  if (!Array.isArray(v)) return [];
  if (raw === null) return v.filter((k): k is string => typeof k === "string" && k !== "").map((k) => [k, 1]);
  return v.filter((e): e is [string, number] =>
    Array.isArray(e) && typeof e[0] === "string" && e[0] !== "" && typeof e[1] === "number" && e[1] > 0);
}

function readUses(): Uses {
  let raw: string | null = null, legacyRaw: string | null = null;
  try {
    raw = localStorage.getItem(USES_KEY);
    if (raw === null) legacyRaw = localStorage.getItem(LEGACY_RECENT_KEY);
  } catch { /* no storage (server render, blocked): no history */ }
  if (usesCache && usesCache.raw === raw && usesCache.legacyRaw === legacyRaw) return usesCache.uses;
  usesCache = { raw, legacyRaw, uses: parseUses(raw, legacyRaw) };
  return usesCache.uses;
}

/** Keys the viewer has used, most used first, ties to the more recent. */
function rankedHistory(): string[] {
  // Array.prototype.sort is stable, so equal counts keep their recency order.
  return [...readUses()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export function getRecentReactions(): string[] {
  const out = rankedHistory().slice(0, QUICK_COUNT);
  for (const k of QUICK_REACTIONS) {
    if (out.length >= QUICK_COUNT) break;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function saveRecentReaction(key: string) {
  const cur = readUses();
  const n = cur.find(([k]) => k === key)?.[1] ?? 0;
  const next: Uses = [[key, n + 1], ...cur.filter(([k]) => k !== key)];
  while (next.length > USES_CAP) {
    // Drop the least used, the oldest of those (searching from the end).
    let drop = next.length - 1;
    for (let i = next.length - 1; i > 0; i--) if (next[i]![1] < next[drop]![1]) drop = i;
    next.splice(drop, 1);
  }
  lsSetJSON(USES_KEY, next);
}

// Render a reaction key: a custom emote image when the key is a known emote
// shortcode, a Discord custom emoji when the aggregate carries its mxc (a
// bridged ":NAME:" reaction), otherwise a unicode emoji via Twemoji. The bridged emoji is the DOWNLOAD, not a thumbnail: a thumbnail of a GIF is one frozen frame, and the <img> is sized by CSS anyway.
export function ReactionKey({ k, emotes, size, mxc }: { k: string; emotes?: EmoteMap; size?: string; mxc?: string | null }) {
  const e = emotes?.[k];
  if (e) {
    return (
      <img
        src={lowerResEmoteUrl(e.url)}
        crossOrigin={emoteCrossOrigin(e.url)}
        alt={k}
        title={k}
        draggable={false}
        className="inline-block object-contain align-middle"
        style={{ height: size ?? "1.1em", width: "auto" }}
      />
    );
  }
  const src = mxc ? mxcToDownload(mxc) : null;
  if (src) {
    return (
      <img
        src={src}
        alt={k}
        title={k}
        draggable={false}
        className="inline-block object-contain align-middle"
        style={{ height: size ?? "1.1em", width: "auto" }}
      />
    );
  }
  return <Twemoji emoji={k} size={size ?? "1.1em"} />;
}

const KIND_ITEMS = [
  { key: "emoji", label: "Emoji" },
  { key: "emote", label: "Emotes" },
] as const;

// The full message-react picker: recents + quick set + an emoji grid (categories)
// + an emote grid (7TV/custom, searchable). Reacting with an emote sends its
// shortcode as the m.reaction key (our own feature; other clients show the text).
export function ReactionPicker({
  x, y, activeKeys, emotes, onPick, onClose,
}: {
  x: number; y: number;
  activeKeys?: Set<string>;
  emotes: EmoteMap;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Emotes are the community's primary reaction vocabulary → default to that tab.
  const [tab, setTab] = useState<"emoji" | "emote">("emote");
  const [cat, setCat] = useState(0);
  const [q, setQ] = useState("");
  const recent = useMemo(() => rankedHistory().slice(0, QUICK_COUNT), []);

  useOutsideClick(ref, onClose, { escape: true });

  const emoteList = useMemo(() => {
    const entries = Object.entries(emotes);
    const ql = q.trim().toLowerCase();
    // Show the full set (scroll for more); only the search narrows it.
    return ql ? entries.filter(([n]) => n.toLowerCase().includes(ql)) : entries;
  }, [emotes, q]);

  const pick = (key: string) => { onPick(key); saveRecentReaction(key); onClose(); };

  const W = 300, H = 360;
  // Visible viewport, not `window.inner*` — this opens from MsgContextMenu's
  // "React" row, which leaves the soft keyboard up, so an inner-size clamp
  // could park a 360px picker under it (same fix as ContextMenu).
  const vp = visibleViewport();
  const left = clampIntoSpan(x - W / 2, W, vp.left, vp.width);
  const top = clampIntoSpan(y - H - 8 > 8 ? y - H - 8 : y + 8, H, vp.top, vp.height);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[calc(var(--z-menu)_+_10)] glass rounded-lg flex flex-col overflow-hidden"
      style={{ left, top, width: W, maxHeight: H }}
    >
      {recent.length > 0 && (
        <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-edge shrink-0">
          <span className="text-3xs uppercase tracking-wider text-muted mr-1">Frequent</span>
          {recent.map((k) => (
            <button key={k} type="button" onClick={() => pick(k)}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-3">
              <ReactionKey k={k} emotes={emotes} size="1.15rem" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-0.5 px-1.5 py-1 border-b border-edge shrink-0">
        {QUICK_REACTIONS.map((e) => (
          <button key={e} type="button" onClick={() => pick(e)}
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
              activeKeys?.has(e) ? "bg-accent/30 hover:bg-accent/40" : "hover:bg-surface-3"
            }`}>
            <Twemoji emoji={e} size="1.15rem" />
          </button>
        ))}
      </div>

      <div className="px-1.5 py-1 border-b border-edge shrink-0">
        <Segmented items={KIND_ITEMS} value={tab} onChange={setTab} label="Reaction kind" />
      </div>

      {tab === "emoji" ? (
        <>
          <div className="flex shrink-0 border-b border-edge">
            {EMOJI_GROUPS.map((g, i) => (
              <button key={g.key} type="button" title={g.key} onClick={() => setCat(i)}
                className={`flex-1 py-1 flex items-center justify-center transition-colors ${cat === i ? "bg-surface-3" : "hover:bg-surface-1"}`}>
                <Twemoji emoji={g.icon} size="1rem" />
              </button>
            ))}
          </div>
          <div className="overflow-y-auto no-scrollbar p-1.5 grid grid-cols-7 gap-0.5">
            {(EMOJI_GROUPS[cat]?.emoji ?? []).map((e) => (
              <button key={e} type="button" title={e} onClick={() => pick(e)}
                className="w-9 h-9 flex items-center justify-center rounded hover:bg-surface-3">
                <Twemoji emoji={e} size="1.35rem" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="p-1.5 shrink-0 border-b border-edge">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search emotes…"
              aria-label="Search emotes"
              className="w-full bg-scrim border border-control rounded px-2 py-1 text-xs text-heading outline-none focus:border-accent"
            />
          </div>
          <div className="overflow-y-auto no-scrollbar p-1.5 grid grid-cols-6 gap-0.5">
            {emoteList.map(([name, info]) => (
              <button key={name} type="button" title={name} onClick={() => pick(name)}
                className="w-10 h-10 flex items-center justify-center rounded hover:bg-surface-3">
                <img src={lowerResEmoteUrl(info.url)} crossOrigin={emoteCrossOrigin(info.url)} alt={name} draggable={false} loading="lazy" className="max-w-[28px] max-h-[28px] object-contain" />
              </button>
            ))}
            {emoteList.length === 0 && (
              <p className="col-span-6 text-center text-muted text-xs py-3">No emotes found</p>
            )}
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
