"use client";

// Admin Panel › Site › Community › Channels and categories: Discord's channel list in the panel's
// shape (spec 2026-10-23 §4.7). Grouped by category; each row says who can see, who can post and
// how long messages are kept; drag a row within its category, or use the arrows or Move to, to
// order it. The order is a key between the new neighbours (orderKeyBetween), so one move writes
// one row.

import { useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChatsCircle, Hash, Megaphone } from "@phosphor-icons/react/dist/ssr";
import { orderKeyBetween, type RoomKind, type RoomRow, type SpaceRow } from "@/app/lib/community/desired";
import { keepWords, rulesSentence } from "@/app/lib/community/communityWords";
import ChannelDialog, { type ChannelValues } from "./ChannelDialog";
import { btn, card, chip, h2, input } from "./parts";

/** Sends one change; resolves true when it was saved. */
export type Save = (url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => Promise<boolean>;

const KIND_ICON: Record<RoomKind, typeof Hash> = { text: Hash, announcement: Megaphone, forum: ChatsCircle };
const iconBtn = `${btn} w-6 px-0 inline-flex items-center justify-center`;

type Group = { space: SpaceRow; depth: number; label: string };

/** Order-key order, compared by code point as the server compares it, then id. */
function byOrder<T extends { orderKey: string; id: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id - b.id));
}

/** The places a channel can be, in the list's order: the community's own channels, then each
 *  category (nested ones under theirs). The hidden supporters space is never a place. */
function groupsOf(spaces: readonly SpaceRow[]): Group[] {
  const hub = spaces.find((s) => s.kind === "hub") ?? null;
  const cats = byOrder(spaces.filter((s) => s.kind === "category"));
  const out: Group[] = hub ? [{ space: hub, depth: 0, label: "No category" }] : [];
  const top = (s: SpaceRow) => s.parentId === null || s.parentId === hub?.id || !cats.some((c) => c.id === s.parentId);
  const walk = (parent: SpaceRow | null, depth: number) => {
    for (const c of cats.filter((s) => (parent ? s.parentId === parent.id : top(s)))) {
      out.push({ space: c, depth, label: c.name });
      if (depth < 4) walk(c, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A key that puts `moving` at `to` in `list` (the list without it), or null when the list's keys
 *  are not the panel's own (a room imported with an order of another scheme). */
function keyAt(list: readonly { orderKey: string }[], to: number): string | null {
  try {
    return orderKeyBetween(list[to - 1]?.orderKey ?? null, list[to]?.orderKey ?? null);
  } catch {
    return null;
  }
}

type Ask = { kind: "archive" | "delete"; room: RoomRow } | null;

export default function ChannelsPage({ spaces, rooms, cap, save, note }: {
  spaces: readonly SpaceRow[]; rooms: readonly RoomRow[]; cap: number; save: Save; note: (m: string) => void;
}) {
  const groups = groupsOf(spaces);
  const [dialog, setDialog] = useState<"new" | RoomRow | null>(null);
  const [newCat, setNewCat] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [typed, setTyped] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);

  const inSpace = (id: number) => byOrder(rooms.filter((r) => r.spaceId === id));
  const places = groups.map((g) => ({ id: g.space.id, label: `${"  ".repeat(g.depth)}${g.label}` }));
  const hub = spaces.find((s) => s.kind === "hub") ?? null;

  async function move(room: RoomRow, spaceId: number, to: number) {
    const list = inSpace(spaceId).filter((r) => r.id !== room.id);
    const orderKey = keyAt(list, Math.max(0, Math.min(to, list.length)));
    if (!orderKey) { note("This list's order came from the chat server and cannot be changed here yet."); return; }
    await save(`/api/admin/community/rooms/${room.id}`, "PATCH", spaceId === room.spaceId ? { orderKey } : { spaceId, orderKey });
  }

  async function moveCategory(g: Group, by: -1 | 1) {
    const siblings = groups.filter((x) => x.space.kind === "category" && x.depth === g.depth && x.space.parentId === g.space.parentId);
    const at = siblings.findIndex((x) => x.space.id === g.space.id);
    const list = siblings.filter((x) => x.space.id !== g.space.id).map((x) => x.space);
    const orderKey = keyAt(list, at + by);
    if (at + by < 0 || at + by > list.length) return;
    if (!orderKey) { note("This list's order came from the chat server and cannot be changed here yet."); return; }
    await save(`/api/admin/community/spaces/${g.space.id}`, "PATCH", { orderKey });
  }

  function drop(e: DragEvent, target: RoomRow) {
    e.preventDefault();
    const moving = rooms.find((r) => r.id === dragId);
    setDragId(null);
    if (!moving || moving.id === target.id || moving.spaceId !== target.spaceId) return;
    // Dropped on a row below it goes after that row, on a row above before it: in the list without
    // the moving row, both are the target's index in the full list.
    void move(moving, target.spaceId, inSpace(target.spaceId).findIndex((r) => r.id === target.id));
  }

  async function submitChannel(v: ChannelValues, room?: RoomRow): Promise<boolean> {
    if (!room) return save("/api/admin/community/rooms", "POST", v);
    const { name, topic, see, post, retentionDays } = v;
    return save(`/api/admin/community/rooms/${room.id}`, "PATCH", { name, topic, see, post, retentionDays });
  }

  const defaultSpaceId = places[0]?.id ?? 0;

  return (
    <section className={card} aria-label="Channels and categories">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={`${h2} mr-auto`}>Channels and categories</h2>
        <button type="button" className={btn} onClick={() => setNewCat("")}>New category</button>
        <button type="button" className={btn} disabled={!places.length} onClick={() => setDialog("new")}>New channel</button>
      </div>
      <p className="mt-0.5 text-xs text-muted">Drag a channel to order it within its category, or use the arrows.</p>

      {newCat !== null && (
        <form role="dialog" aria-label="New category" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save("/api/admin/community/spaces", "POST", { name: newCat.trim(), parentId: hub?.id ?? null }).then((ok) => { if (ok) setNewCat(null); });
          }}>
          <input className={input} value={newCat} maxLength={100} aria-label="Category name" placeholder="Stream" onChange={(e) => setNewCat(e.target.value)} />
          <button type="button" className={btn} onClick={() => setNewCat(null)}>Cancel</button>
          <button type="submit" className={btn} disabled={!newCat.trim()}>Make category</button>
        </form>
      )}

      {dialog && (
        <ChannelDialog room={dialog === "new" ? undefined : dialog} places={places} defaultSpaceId={defaultSpaceId} cap={cap}
          onCancel={() => setDialog(null)} onSubmit={(v) => submitChannel(v, dialog === "new" ? undefined : dialog)} />
      )}

      {!groups.length && (
        <p className="mt-3 text-xs text-muted">
          Nothing here yet. Make a category, then add channels to it. The rooms your community already has show here once they are imported.
        </p>
      )}

      <div className="mt-3 space-y-3">
        {groups.map((g) => {
          const list = inSpace(g.space.id);
          const isCat = g.space.kind === "category";
          const empty = !list.length && !spaces.some((s) => s.parentId === g.space.id && s.kind === "category");
          return (
            <div key={g.space.id} data-category={g.space.id} style={{ marginLeft: `${g.depth * 12}px` }}>
              <div className="flex flex-wrap items-center gap-1.5 border-b border-edge pb-1">
                {renaming?.id === g.space.id ? (
                  <form className="flex flex-1 flex-wrap items-center gap-2" onSubmit={(e) => {
                    e.preventDefault();
                    void save(`/api/admin/community/spaces/${g.space.id}`, "PATCH", { name: renaming.name.trim() }).then((ok) => { if (ok) setRenaming(null); });
                  }}>
                    <input className={input} value={renaming.name} maxLength={100} aria-label="Category name" onChange={(e) => setRenaming({ id: g.space.id, name: e.target.value })} />
                    <button type="button" className={btn} onClick={() => setRenaming(null)}>Cancel</button>
                    <button type="submit" className={btn} disabled={!renaming.name.trim()}>Save</button>
                  </form>
                ) : (
                  <>
                    <span className="mr-auto text-2xs font-semibold uppercase tracking-wide text-body-dim">{g.label}</span>
                    {isCat && (
                      <>
                        <button type="button" className={iconBtn} aria-label={`Move ${g.label} up`} onClick={() => void moveCategory(g, -1)}><ArrowUp size={12} /></button>
                        <button type="button" className={iconBtn} aria-label={`Move ${g.label} down`} onClick={() => void moveCategory(g, 1)}><ArrowDown size={12} /></button>
                        <button type="button" className={btn} onClick={() => setRenaming({ id: g.space.id, name: g.space.name })}>Rename</button>
                        {empty && !g.space.matrixRoomId && (
                          <button type="button" className={btn} onClick={() => void save(`/api/admin/community/spaces/${g.space.id}`, "DELETE")}>Delete</button>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
              {!list.length && <p className="mt-1 text-2xs text-muted">No channels.</p>}
              <ul className="mt-1 space-y-1">
                {list.map((r, i) => {
                  const Icon = KIND_ICON[r.kind];
                  return (
                    <li key={r.id} data-room={r.id} draggable onDragStart={() => setDragId(r.id)} onDragEnd={() => setDragId(null)}
                      onDragOver={(e) => { if (dragId !== null && rooms.find((x) => x.id === dragId)?.spaceId === r.spaceId) e.preventDefault(); }}
                      onDrop={(e) => drop(e, r)}
                      className={`rounded-md px-1.5 py-1 hover:bg-surface-2 ${r.archived ? "opacity-60" : ""} ${dragId === r.id ? "outline outline-1 outline-edge-bright" : ""}`}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Icon size={14} className="shrink-0 text-muted" aria-label={r.kind} />
                        <span data-name className="min-w-0 truncate text-sm text-body">{r.name}</span>
                        {r.encrypted && <span className={chip}>Encrypted</span>}
                        {r.discordChannelId && <span className={chip}>Linked to Discord</span>}
                        {r.archived && <span className={chip}>Archived</span>}
                        <span className="ml-auto flex flex-wrap items-center gap-1">
                          <button type="button" className={iconBtn} aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => void move(r, r.spaceId, i - 1)}><ArrowUp size={12} /></button>
                          <button type="button" className={iconBtn} aria-label={`Move ${r.name} down`} disabled={i === list.length - 1} onClick={() => void move(r, r.spaceId, i + 1)}><ArrowDown size={12} /></button>
                          {places.length > 1 && (
                            <select className={`${input} h-6 w-24 basis-24 flex-none bg-surface-2`} aria-label={`Move ${r.name} to`} value=""
                              onChange={(e) => { const to = Number(e.target.value); if (to && to !== r.spaceId) void move(r, to, inSpace(to).length); }}>
                              <option value="">Move to…</option>
                              {places.filter((p) => p.id !== r.spaceId).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                          )}
                          <button type="button" className={btn} onClick={() => setDialog(r)}>Edit</button>
                          {r.archived
                            ? <button type="button" className={btn} onClick={() => void save(`/api/admin/community/rooms/${r.id}/unarchive`, "POST")}>Bring back</button>
                            : <button type="button" className={btn} onClick={() => { setAsk({ kind: "archive", room: r }); setTyped(""); }}>Archive</button>}
                          {!r.matrixRoomId && <button type="button" className={btn} onClick={() => { setAsk({ kind: "delete", room: r }); setTyped(""); }}>Delete</button>}
                        </span>
                      </div>
                      <p data-sentence className="mt-0.5 text-2xs text-secondary">{rulesSentence(r)}</p>
                      <p className="text-2xs text-muted">{keepWords(r.retentionDays, cap)}</p>
                      {ask?.room.id === r.id && (
                        <div role="dialog" aria-label={`${ask.kind === "archive" ? "Archive" : "Delete"} #${r.name}`} className="mt-1.5 rounded-md border border-edge bg-surface-2 p-2">
                          {ask.kind === "archive" ? (
                            <p className="text-xs text-body">Hide #{r.name} from the community and keep its messages? People can no longer post in it.</p>
                          ) : (
                            <>
                              <p className="text-xs text-body">Delete #{r.name} and its messages for everyone? Type the channel name to confirm.</p>
                              <p className="mt-0.5 text-xs text-secondary">This channel was never created on the server, so nothing else is removed.</p>
                              <input className={`${input} mt-1.5 w-full`} value={typed} aria-label="Channel name to confirm" onChange={(e) => setTyped(e.target.value)} />
                            </>
                          )}
                          <div className="mt-1.5 flex justify-end gap-2">
                            <button type="button" className={btn} onClick={() => setAsk(null)}>Cancel</button>
                            {ask.kind === "archive"
                              ? <button type="button" className={btn} onClick={() => void save(`/api/admin/community/rooms/${r.id}/archive`, "POST").then((ok) => { if (ok) setAsk(null); })}>Archive</button>
                              : <button type="button" className={btn} disabled={typed !== r.name}
                                  onClick={() => void save(`/api/admin/community/rooms/${r.id}`, "DELETE", { confirm: typed }).then((ok) => { if (ok) setAsk(null); })}>Delete</button>}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
