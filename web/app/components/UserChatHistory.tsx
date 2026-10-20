"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getJson } from "@/app/lib/http";
import { renderText } from "@/app/lib/renderText";
import { useEmotes } from "@/app/lib/useEmotes";
import PlatformIcon, { PLATFORM_COLORS } from "./PlatformIcon";
import type { ChatMsg } from "@/app/lib/chatMsg";
import { LoadingState } from "./Spinner";
import EmptyState from "./EmptyState";
import { normalizePlatform } from "@/app/lib/nativePlatform";

type Cursor = { beforeTs: string; beforePlatform: string; beforeId: string };

type HistRow = {
  id: string | number;
  platform: string;
  message: string;
  ts: number | string;
  deleted?: boolean;
  emotes?: Record<string, string> | null;
};

type HistResp = { messages: HistRow[]; nextCursor: Cursor | null };

/** One page. Small on purpose — the card is short and paging is one click. */
const PAGE = 30;

function rowTime(ts: number | string): string {
  const d = new Date(typeof ts === "string" ? ts : Number(ts));
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Calendar-day key for the day-marker divider (rows span multiple days). */
const dayKey = (ts: number | string): string =>
  new Date(typeof ts === "string" ? ts : Number(ts)).toDateString();

/** Short day label shown on the divider between days ("Jul 24"). */
const dayLabel = (ts: number | string): string =>
  new Date(typeof ts === "string" ? ts : Number(ts)).toLocaleDateString([], { month: "short", day: "numeric" });

const rowKey = (r: HistRow) => `${r.platform}:${r.id}`;

/**
 * What this person has been saying — the middle of the user card.
 *
 * Reads like the chat it came from: same chat-relative type scale
 * (--text-chat-*, so it follows the user's font-size slider) and the same
 * `renderText` pipeline, so emotes, Twemoji, links and the deceptive-link
 * guard all behave identically to a real chat row. As plain text, a chatter who
 * talks mostly in emotes would read as gibberish.
 *
 * Per-message emote maps are not persisted — neither stream.chat_log nor
 * site.chat_messages has an emotes column; only the live WS frame carries one.
 * So fetched rows resolve against the global 7TV/BTTV/FFZ map only, and a
 * Twitch subscriber emote or a YouTube custom emoji in old history renders as
 * its name. Live rows are complete, which is why the same message can look
 * different before and after a reload.
 *
 * Newest at the BOTTOM, scrolled there on open, with "load older" at the top —
 * the same reading direction as chat, so the most recent thing (usually why the
 * card was opened) is the thing you see. A day divider is drawn wherever the
 * calendar day changes, since scroll-back routinely spans several days.
 *
 * MOD-ONLY. This is rendered only inside the user card's mod "History & tools"
 * section, so it always has a mod's privileges: real scroll-back from
 * /api/mod/chat-history (a `user` filter by matrix or canonical id, a keyset
 * cursor, and a `q` search across BOTH stream.chat_log and site.chat_messages).
 * The search box maps onto `q`, so it covers this person's whole recorded
 * history, not just the loaded page. There is deliberately no non-mod tier:
 * serving arbitrary users a queryable log of any other user's history would
 * change what the site discloses.
 */
export default function UserChatHistory({
  lookupKey,
  matrixId,
  publicId,
  liveMessages,
}: {
  /** The site account, else the canonical (resolved for mods) — what /api/mod/chat-history accepts as `user`. */
  lookupKey: string | null;
  matrixId?: string | null;
  publicId?: string | null;
  liveMessages: ChatMsg[];
}) {
  const emotes = useEmotes();
  const [fetched, setFetched] = useState<HistRow[] | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canFetch = !!lookupKey;

  // Messages from this person already on screen. Matched on identity, never on
  // username: display names collide across platforms and can be changed.
  const live = useMemo(() => {
    if (!matrixId && !publicId) return [];
    return liveMessages.filter(
      (m) =>
        !m.system &&
        ((matrixId && m.matrixId === matrixId) || (publicId && m.publicId === publicId))
    );
  }, [liveMessages, matrixId, publicId]);

  // First page (and every re-search). Debounced while typing.
  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      const qs = new URLSearchParams({ user: lookupKey!, limit: String(PAGE) });
      if (query.trim()) qs.set("q", query.trim());
      getJson<HistResp>(`/api/mod/chat-history?${qs}`)
        .then((d) => {
          if (cancelled) return;
          setFetched(d.messages ?? []);
          setCursor(d.nextCursor ?? null);
        })
        .catch(() => { if (!cancelled) { setFetched([]); setCursor(null); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 250 : 0);   // debounce typing, but load immediately on open
    return () => { cancelled = true; clearTimeout(t); };
  }, [canFetch, lookupKey, query]);

  // "Load older" — prepends, and preserves the scroll position so the row you
  // were looking at doesn't jump when content is inserted above it.
  const loadMore = useCallback(async () => {
    if (!canFetch || !cursor || loadingMore) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevH = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const qs = new URLSearchParams({ user: lookupKey!, limit: String(PAGE), ...cursor });
      if (query.trim()) qs.set("q", query.trim());
      const d = await getJson<HistResp>(`/api/mod/chat-history?${qs}`);
      setFetched((prev) => [...(d.messages ?? []), ...(prev ?? [])]);
      setCursor(d.nextCursor ?? null);
      requestAnimationFrame(() => {
        const e2 = scrollRef.current;
        if (e2) e2.scrollTop = prevTop + (e2.scrollHeight - prevH);
      });
    } catch {
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }, [canFetch, cursor, lookupKey, query, loadingMore]);

  // Merge fetched (older) with live (newest), de-duplicated so a message that is
  // in BOTH the fetched page and the live buffer appears once.
  const rows: HistRow[] = useMemo(() => {
    const liveRows: HistRow[] = live.map((m) => ({
      id: m.id, platform: m.platform, message: m.message, ts: m.ts,
      deleted: m.deleted, emotes: m.emotes,
    }));
    // Search is server-side (`q` covers the whole history); the live buffer just
    // supplements the fetched page with the newest messages, deduped below.
    const seen = new Set<string>();
    const out: HistRow[] = [];
    for (const r of [...(fetched ?? []), ...liveRows]) {
      if (seen.has(rowKey(r))) continue;
      seen.add(rowKey(r));
      out.push(r);
    }
    return out.sort((a, b) => Number(new Date(a.ts)) - Number(new Date(b.ts)));
  }, [fetched, live]);

  // Stick to the bottom: on open, and whenever a new message lands while the
  // reader is already at the bottom. Scrolling up to read older history is not
  // interrupted — the same anchoring rule the chat itself uses.
  const atBottomRef = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="px-3 py-2 border-t border-edge">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-3xs uppercase tracking-wide text-muted shrink-0">Recent chat</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search all history…"
          aria-label="Search this user's messages"
          className="flex-1 min-w-0 bg-surface-2 border border-edge rounded px-1.5 py-0.5 text-2xs outline-none focus:ring-1 focus:ring-edge-strong placeholder-secondary"
        />
      </div>

      {loading && fetched === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState>
          {query ? "No messages match." : "No messages recorded."}
        </EmptyState>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          // Both-axes `overscroll-contain` is deliberate, unlike the pager
          // scrollers (Timeline.tsx, ThreadPanel.tsx): this list lives inside a
          // floating user card, not a pane of any snap row, and must not page
          // whatever sits behind it. Do not narrow it to `overscroll-y-contain`.
          className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5 pr-0.5"
        >
          {cursor && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full py-1 mb-1 rounded bg-surface-2 hover:bg-surface-3 text-3xs text-muted hover:text-body-dim transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load older"}
            </button>
          )}
          {rows.map((r, i) => {
            const prev = i > 0 ? rows[i - 1] : undefined;
            return (
            <div key={rowKey(r)}>
              {/* Day divider wherever the calendar day changes between rows (rows
                  sort ascending, so this labels the start of each new day). */}
              {prev && dayKey(prev.ts) !== dayKey(r.ts) && (
                <div className="text-3xs text-muted text-center py-0.5 border-b border-edge/50">
                  {dayLabel(r.ts)}
                </div>
              )}
              <div
                className="flex items-baseline gap-1.5 leading-snug"
                // Chat-relative type: follows the viewer's chat font-size slider,
                // exactly like a real chat row; a fixed px size would drift out of
                // step with that setting.
                style={{ fontSize: "var(--text-chat-sm)" }}
              >
                {/* Deliberately a step below the message text: the timestamp is
                    scanning furniture, and at the same size it crowded a narrow
                    card. Own font-size, CAPPED so it stays small even at the
                    largest chat font (it must not scale up with the message). */}
                <span
                  className="shrink-0 text-muted tabular-nums"
                  style={{ fontSize: "min(var(--text-chat-xs), 0.68rem)" }}
                >
                  {rowTime(r.ts)}
                </span>
                <span className="shrink-0" style={{ color: PLATFORM_COLORS[String(normalizePlatform(r.platform))] }}>
                  <PlatformIcon platform={r.platform} size="0.85em" />
                </span>
                <span className={`min-w-0 break-words ${r.deleted ? "text-muted line-through" : "text-body-dim"}`}>
                  {renderText(r.message, emotes, r.emotes)}
                </span>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
