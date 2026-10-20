"use client";

// The mod panel's Chat history: a FROZEN SNAPSHOT
// in chat order — oldest at the top, newest at the bottom, opened scrolled to the bottom — that
// never moves under the mod reading it unless they switch on "Follow new messages"; Refresh
// re-takes it. Search tools (text, user, platform, deleted only) with the active filters as chips,
// a name click to filter on that person, Jump to a moment, and every message fully
// inspectable: the row opens the user card with its mod section open, whose first block is the
// message's details. Messages render with live chat's emote renderer (renderText) and wrap; the
// platform icons are a toggle, off by default. The mod log's actions in the snapshot's span sit in
// the stream as system rows. The ⋯ on a row is the same mod menu a live chat line has, minus
// "Open in mod panel". It has its own pop-out (/mod/chat, ChatHistoryWindow).
// Internal to the `moderation` feature.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { siteName } from "@/app/lib/siteName";
import { getJson } from "@/app/lib/http";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { LoadingState } from "@/app/components/Spinner";
import { card, h2, btn, timeAgo } from "../shared";
import EmptyState from "@/app/components/EmptyState";
import PlatformIcon from "@/app/components/PlatformIcon";
import UserCard from "@/app/components/UserCard";
import ModUndoToast from "@/app/components/ModUndoToast";
import { MessageContextMenu } from "@/app/components/MessageContextMenu";
import { Toggle } from "@/app/components/SettingsControls";
import type { ChatMsg } from "@/app/lib/chatMsg";
import { NATIVE_PLATFORM, isNativePlatform } from "@/app/lib/nativePlatform";
import type { HistMsg, HistCursor } from "@/app/lib/modHistory";
import { modDelete } from "@/app/lib/modQuickActions";
import { renderText } from "@/app/lib/renderText";
import { useEmotes } from "@/app/lib/useEmotes";
import { useChatSocket } from "@/app/lib/useChatSocket";
import { modIdsNow } from "@/app/lib/modIdentity";
import { weave, modLine, frameToHist, passesFilters, personFilter, type ModLogRow, type HistFilters } from "@/app/lib/chatHistoryRows";

const HIST_PLATFORMS = ["", NATIVE_PLATFORM, "twitch", "kick", "youtube", "streamplace"] as const;
const PAGE = 50;
const ICONS_KEY = "bb_hist_icons";

const NO_FILTERS: HistFilters = { q: "", user: "", platform: "", deletedOnly: false };
type Page = { messages: HistMsg[]; nextCursor: HistCursor | null };

function query(f: HistFilters, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams({ limit: String(PAGE), ...extra });
  if (f.q.trim()) qs.set("q", f.q.trim());
  if (f.user.trim()) qs.set("user", f.user.trim());
  if (f.platform) qs.set("platform", f.platform);
  if (f.deletedOnly) qs.set("deleted", "1");
  return `/api/mod/chat-history?${qs}`;
}

/** A snapshot's first page; `at` = Jump to: the messages from that moment back (a cursor at the
 *  moment, past every platform and id). */
function snapshotUrl(f: HistFilters, at: string | null): string {
  return query(f, at ? { beforeTs: new Date(at).toISOString(), beforePlatform: "~", beforeId: "9223372036854775807" } : {});
}

const platformWord = (p: string) => (p === "" ? "all platforms" : isNativePlatform(p) ? siteName() : p);
const rowKey = (m: { platform: string; id: number }) => `${m.platform}:${m.id}`;

export default function ChatHistorySection({ popout = false, onPopout }: {
  /** Rendered as the /mod/chat pop-out: the list takes the window's height, no pop-out button. */
  popout?: boolean;
  /** Opens the pop-out (the floating panel's button). */
  onPopout?: () => void;
}) {
  const [draft, setDraft] = useState<HistFilters>(NO_FILTERS);
  const [msgs, setMsgs] = useState<HistMsg[] | null>(null);
  const [mods, setMods] = useState<ModLogRow[]>([]);
  const [cursor, setCursor] = useState<HistCursor | null>(null);
  const [takenAt, setTakenAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [jump, setJump] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; m: HistMsg } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // The filters the snapshot on screen was taken with (Load older / Refresh / Follow repeat them).
  const [applied, setApplied] = useState<HistFilters>(NO_FILTERS);
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [iconsRaw, setIconsRaw] = useLocalStorageString(ICONS_KEY);
  const icons = iconsRaw === "1";
  const emotes = useEmotes();
  const listRef = useRef<HTMLDivElement>(null);
  const ulRef = useRef<HTMLUListElement>(null);
  // What the next layout pass does to the scroll: stick to the bottom (a new snapshot, a followed
  // message while at the bottom), or keep the reader's place (older rows added above).
  const scrollPlan = useRef<{ kind: "bottom" } | { kind: "keep"; fromBottom: number } | null>(null);

  const loadMods = useCallback(async (list: HistMsg[]) => {
    const oldest = list.reduce((a, m) => Math.min(a, m.ts), Infinity);
    if (!Number.isFinite(oldest)) { setMods([]); return; }
    const qs = new URLSearchParams({ limit: "100", from: new Date(oldest).toISOString(), to: new Date().toISOString() });
    const d = await getJson<{ entries: ModLogRow[] }>(`/api/mod/log?${qs}`).catch(() => null);
    setMods(d?.entries ?? []);
  }, []);

  const take = useCallback((d: Page, f: HistFilters, at: string | null) => {
    setMsgs(d.messages);
    setCursor(d.nextCursor);
    setTakenAt(Date.now());
    setApplied(f);
    setJumpedTo(at);
    setOpenRow(null);
    scrollPlan.current = { kind: "bottom" };
    void loadMods(d.messages);
  }, [loadMods]);
  const snapshot = useCallback(async (f: HistFilters, at: string | null) => {
    setBusy(true);
    try {
      take(await getJson<Page>(snapshotUrl(f, at)), f, at);
    } catch {
      setMsgs((prev) => prev ?? []);
    } finally {
      setBusy(false);
    }
  }, [take]);

  // The snapshot is taken once, when the section opens — and then never moves on its own.
  useEffect(() => {
    getJson<Page>(snapshotUrl(NO_FILTERS, null)).then((d) => take(d, NO_FILTERS, null)).catch(() => setMsgs([]));
  }, [take]);

  async function older() {
    if (!cursor || !msgs) return;
    setBusy(true);
    try {
      const d = await getJson<Page>(query(applied, { ...cursor }));
      const el = listRef.current;
      scrollPlan.current = { kind: "keep", fromBottom: el ? el.scrollHeight - el.scrollTop : 0 };
      const next = [...d.messages, ...msgs];
      setMsgs(next);
      setCursor(d.nextCursor);
      void loadMods(next);
    } finally { setBusy(false); }
  }

  // Whether the reader is at the bottom: rows that arrive later (the mod actions, an emote image
  // loading, a followed message) keep them there instead of leaving them mid-list.
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const plan = scrollPlan.current;
    scrollPlan.current = null;
    if (plan?.kind === "keep") { el.scrollTop = el.scrollHeight - plan.fromBottom; return; }
    if (plan?.kind === "bottom") atBottom.current = true;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  });
  const listEl = msgs !== null && msgs.length > 0;
  useEffect(() => {
    const el = listRef.current;
    const inner = ulRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [listEl]);

  // Follow new messages (C2): only while switched on, only frames that pass the snapshot's filters
  // — and only on the newest snapshot, not one jumped back in time.
  useChatSocket((f) => {
    if (!follow || jumpedTo) return;
    if (f.type === "message") {
      const h = frameToHist(f);
      // A live frame carries only its public id; the mod lookup's cached answer fills the
      // canonical when it has one (modIdentity.ts — it asks otherwise, for the next frame).
      if (h && !h.canonicalId) h.canonicalId = modIdsNow(f.publicId)?.canonicalId ?? null;
      if (!h || !passesFilters(h, applied)) return;
      setMsgs((prev) => (prev ? [...prev, h] : [h]));
    } else if (f.type === "delete") {
      setMsgs((prev) => prev?.map((m) => (String(m.id) === String(f.messageId) && (!f.platform || m.platform === f.platform) ? { ...m, deleted: true } : m)) ?? prev);
    } else if (f.type === "purge") {
      const gone = new Set(f.ids.map((x) => `${x.platform}:${x.id}`));
      setMsgs((prev) => prev?.map((m) => (gone.has(rowKey(m)) ? { ...m, deleted: true } : m)) ?? prev);
    }
  });

  function filterOn(next: HistFilters) {
    setDraft(next);
    void snapshot(next, null);
  }

  const input = "rounded-lg bg-surface-1 border border-edge px-3 py-1.5 text-sm text-body placeholder:text-muted outline-none focus:border-edge-strong";
  const chips: { label: string; clear: HistFilters }[] = [
    ...(applied.q.trim() ? [{ label: `contains “${applied.q.trim()}”`, clear: { ...applied, q: "" } }] : []),
    ...(applied.user.trim() ? [{ label: `user ${applied.user.trim()}`, clear: { ...applied, user: "" } }] : []),
    ...(applied.platform ? [{ label: platformWord(applied.platform), clear: { ...applied, platform: "" } }] : []),
    ...(applied.deletedOnly ? [{ label: "deleted only", clear: { ...applied, deletedOnly: false } }] : []),
  ];
  const rows = msgs ? weave(msgs, mods, applied.user.trim()) : null;

  return (
    <section className={`${card} ${popout ? "flex min-h-0 flex-1 flex-col" : ""}`}>
      <div className="mb-2 flex items-center gap-2">
        {/* The pop-out's window band already says "Chat history". */}
        {!popout && <h2 className={h2} data-repeats-place="">Chat history</h2>}
        {onPopout && !popout && (
          <button type="button" className={`${btn} ml-auto`} onClick={onPopout} title="Open Chat history in its own window">Pop out ↗</button>
        )}
      </div>
      <form className="flex flex-wrap items-center gap-2 mb-2" onSubmit={(e) => { e.preventDefault(); void snapshot(draft, null); }}>
        <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          placeholder="message contains…" aria-label="Message contains" className={`${input} flex-1 min-w-40`} />
        <input value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })}
          placeholder="user, user id or Matrix id" aria-label="User" className={`${input} w-44`} />
        <select value={draft.platform} onChange={(e) => setDraft({ ...draft, platform: e.target.value })} aria-label="Platform"
          className="rounded-lg bg-surface-1 border border-edge px-2 py-1.5 text-xs text-body outline-none focus:border-edge-strong">
          {HIST_PLATFORMS.map((p) => <option key={p} value={p}>{platformWord(p)}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-secondary select-none">
          <input type="checkbox" checked={draft.deletedOnly} onChange={(e) => setDraft({ ...draft, deletedOnly: e.target.checked })} />
          Deleted only
        </label>
        <button type="submit" className={btn} disabled={busy}>Search</button>
      </form>
      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Filters on">
          {chips.map((c) => (
            <button key={c.label} type="button" onClick={() => filterOn(c.clear)} aria-label={`Remove the filter ${c.label}`}
              className="inline-flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-body hover:bg-surface-3">
              {c.label} <span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3 text-xs text-secondary">
        <label className="flex items-center gap-1.5">
          Jump to
          <input type="datetime-local" value={jump} onChange={(e) => setJump(e.target.value)} aria-label="Jump to a moment"
            className="rounded-lg bg-surface-1 border border-edge px-2 py-1 text-xs text-body" />
        </label>
        <button type="button" className={btn} disabled={busy || !jump} onClick={() => void snapshot(applied, jump)}>Go</button>
        <span className="flex items-center gap-1.5">
          <Toggle on={follow} onToggle={() => setFollow(!follow)} label="Follow new messages" disabled={!!jumpedTo} />
          Follow new messages
        </span>
        <span className="flex items-center gap-1.5">
          <Toggle on={icons} onToggle={() => setIconsRaw(icons ? "0" : "1")} label="Platform icons" />
          Platforms
        </span>
        <span className="ml-auto" role="status">
          {takenAt ? `Snapshot at ${new Date(takenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
          {jumpedTo ? ` · from ${new Date(jumpedTo).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} back` : ""}
          {follow && !jumpedTo ? " · following" : ""}
        </span>
        <button type="button" className={btn} disabled={busy} onClick={() => void snapshot(applied, jumpedTo)}>Refresh</button>
      </div>
      {flash && <p role="status" className="mb-2 text-xs text-amber-300">{flash}</p>}

      {rows === null || (busy && rows.length === 0) ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState>
          {chips.length ? "No messages match these filters." : "Every message from every platform shows here once someone chats — newest at the bottom."}
        </EmptyState>
      ) : (
        <div ref={listRef} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}
          className={`overflow-y-auto overscroll-contain ${popout ? "min-h-0 flex-1" : "max-h-[min(60vh,40rem)]"}`} data-hist-list>
          {cursor && (
            <button className={`${btn} mb-2`} disabled={busy} onClick={() => void older()}>Load older</button>
          )}
          <ul ref={ulRef} className="space-y-0.5">
            {rows.map((r) => {
              if (r.kind === "mod") {
                return (
                  <li key={r.key} className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-xs text-secondary bg-surface-2/50" data-mod-row>
                    <span aria-hidden="true">🛡</span>
                    <span className="min-w-0 flex-1 break-words">{modLine(r.e)}</span>
                    <span className="shrink-0 text-muted" title={new Date(r.e.at).toLocaleString()}>{timeAgo(r.e.at)}</span>
                  </li>
                );
              }
              const m = r.m;
              const key = r.key;
              return (
                <li key={key}>
                  <div className="flex items-start gap-1 rounded-lg hover:bg-surface-1 transition-colors">
                    <div className="min-w-0 flex-1 px-2 py-1 text-sm leading-snug break-words">
                      {icons && <span className="mr-1 inline-block align-[-0.1em]"><PlatformIcon platform={m.platform} size="0.9em" /></span>}
                      <button type="button" className="font-medium text-body hover:underline" title={`Show only ${m.username}`}
                        onClick={() => filterOn({ ...applied, user: personFilter(m) })}>{m.username}</button>
                      <span className="text-muted">: </span>
                      <span role="button" tabIndex={0} aria-expanded={openRow === key} aria-label={`Details of ${m.username}'s message`}
                        onClick={() => setOpenRow(openRow === key ? null : key)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenRow(openRow === key ? null : key); } }}
                        className={`cursor-pointer text-secondary ${m.deleted ? "line-through text-red-300/70" : ""}`}>
                        {renderText(m.message, emotes, m.emotes ?? null)}
                      </span>
                    </div>
                    <span className="shrink-0 pt-1 text-xs text-muted" title={new Date(m.ts).toLocaleString()}>{timeAgo(m.ts)}</span>
                    <button type="button" className="shrink-0 rounded px-1.5 pt-0.5 text-muted hover:text-strong hover:bg-surface-1" title="Mod actions"
                      aria-label={`Mod actions for ${m.username}'s message`}
                      onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setMenu({ x: b.left, y: b.bottom, m }); }}>⋯</button>
                  </div>
                  {openRow === key && (
                    <div className="ml-4 mt-1 mb-2 rounded-lg border border-edge bg-surface-1">
                      <UserCard
                        msg={{
                          id: m.id, platform: m.platform, username: m.username, message: m.message,
                          isMod: false, isVip: false, isMember: false, ts: m.ts,
                          canonicalId: m.canonicalId, matrixId: m.matrixId, deleted: m.deleted,
                        } satisfies ChatMsg}
                        isMod
                        inPanel
                        initialToolsOpen
                        onClose={() => setOpenRow(null)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {menu && (
        <MessageContextMenu
          x={menu.x}
          y={menu.y}
          msg={{ id: menu.m.id, platform: menu.m.platform, matrixId: menu.m.matrixId, canonicalId: menu.m.canonicalId }}
          onDetails={() => setOpenRow(rowKey(menu.m))}
          onDelete={menu.m.deleted ? undefined : () => { void modDelete(menu.m).then((r) => setFlash(r.ok ? "Deleted." : r.error)); }}
          onResult={setFlash}
          onClose={() => setMenu(null)}
          inModPanel
        />
      )}
      <ModUndoToast />
    </section>
  );
}
