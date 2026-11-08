"use client";

// A channel's settings, new or existing (Admin Panel › Site › Community). Rules held by the form's
// shape: encryption is offered only when not everyone can see the channel, only when it is made,
// and only after its costs are on screen (spec 2026-10-23 §4.4); how long messages are kept is
// the server's limit (Forever only when the install has none) or 1 day up to the cap (§4.5). The
// server checks all of it again.

import { useState } from "react";
import { Choice, Toggle } from "@/app/components/SettingsControls";
import type { PostRule, RoomKind, RoomRow, SeeRule } from "@/app/lib/community/desired";
import {
  ENCRYPTION_COSTS, FORUM_ENCRYPTION_COST, KIND_WORDS, POST_WORDS, SEE_WORDS, defaultKeepDays, keepMaxDays,
} from "@/app/lib/community/communityWords";
import { btn, h3, input } from "./parts";

/** What the dialog sends: a new channel's fields, or an existing one's changes. */
export type ChannelValues = {
  spaceId: number; kind: RoomKind; name: string; topic: string | null; see: SeeRule; post: PostRule;
  retentionDays: number | null; encrypted: boolean;
};

const select = `${input} h-6 bg-surface-2`;
const KINDS = (Object.keys(KIND_WORDS) as RoomKind[]).map((k) => ({ value: k, label: KIND_WORDS[k] }));

export default function ChannelDialog({ room, places, defaultSpaceId, cap, onCancel, onSubmit }: {
  /** The channel being changed; absent for a new one. */
  room?: RoomRow;
  /** Where a new channel can go: the community itself and each category. */
  places: readonly { id: number; label: string }[];
  defaultSpaceId: number;
  /** The install's longest keep (community.retentionCapDays; 0 = no limit). */
  cap: number;
  onCancel: () => void;
  /** Resolves true when saved (the dialog then closes). */
  onSubmit: (v: ChannelValues) => Promise<boolean>;
}) {
  const isNew = !room;
  const [kind, setKind] = useState<RoomKind>(room?.kind ?? "text");
  const [name, setName] = useState(room?.name ?? "");
  const [topic, setTopic] = useState(room?.topic ?? "");
  const [spaceId, setSpaceId] = useState(room?.spaceId ?? defaultSpaceId);
  const [see, setSee] = useState<SeeRule>(room?.see ?? "everyone");
  const [post, setPost] = useState<PostRule>(room?.post ?? "everyone");
  const [forever, setForever] = useState(room ? room.retentionDays === null : defaultKeepDays("text", cap) === null);
  const [days, setDays] = useState(String(room?.retentionDays ?? defaultKeepDays("text", cap) ?? Math.min(30, keepMaxDays(cap))));
  /** The post rule chosen before Announcement took it over: going back restores it. */
  const [postBefore, setPostBefore] = useState<PostRule | null>(null);
  const [encrypted, setEncrypted] = useState(room?.encrypted ?? false);
  const [busy, setBusy] = useState(false);

  // Encryption exists only where not everyone can see; going back to Everyone takes it away.
  const canEncrypt = isNew && see !== "everyone";
  const encrypt = canEncrypt && encrypted;

  function pickKind(k: RoomKind) {
    // An announcement channel is posted in by mods (spec §4.3); leaving it gives back what was chosen.
    if (k === "announcement" && kind !== "announcement") { setPostBefore(post); setPost("mods"); }
    if (k !== "announcement" && kind === "announcement") { setPost(postBefore ?? "everyone"); setPostBefore(null); }
    setKind(k);
    if (isNew) {
      const d = defaultKeepDays(k, cap);
      setForever(d === null);
      if (d !== null) setDays(String(d));
    }
  }

  const dayCount = Number(days);
  const daysOk = forever || (Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= keepMaxDays(cap));
  const ok = name.trim().length >= 1 && name.trim().length <= 100 && daysOk && !busy;
  const title = isNew ? "New channel" : `Channel settings: #${room.name}`;

  async function submit() {
    if (!ok) return;
    setBusy(true);
    const saved = await onSubmit({
      spaceId, kind, name: name.trim().replace(/^#+/, ""), topic: topic.trim() || null, see, post,
      retentionDays: forever ? null : dayCount, encrypted: encrypt,
    }).catch(() => false);
    setBusy(false);
    if (saved) onCancel();
  }

  return (
    <div role="dialog" aria-label={title} className="mt-3 rounded-lg border border-edge bg-surface-2 p-3">
      <h3 className={h3}>{title}</h3>
      <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {isNew && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-body-dim">Kind</span>
            <Choice label="Kind" options={KINDS} value={kind} onChange={pickKind} />
          </div>
        )}
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-body-dim">Name</span>
          <input className={input} value={name} maxLength={100} aria-label="Channel name" placeholder="general"
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-body-dim">Topic</span>
          <input className={input} value={topic} maxLength={1000} aria-label="Topic" placeholder="What this channel is for"
            onChange={(e) => setTopic(e.target.value)} />
        </label>
        {isNew && places.length > 1 && (
          <label className="flex flex-wrap items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-body-dim">Category</span>
            <select className={select} aria-label="Category" value={spaceId} onChange={(e) => setSpaceId(Number(e.target.value))}>
              {places.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-body-dim">Who can see</span>
          <select className={select} aria-label="Who can see" value={see} onChange={(e) => setSee(e.target.value as SeeRule)}>
            {(Object.keys(SEE_WORDS) as SeeRule[]).map((k) => <option key={k} value={k}>{SEE_WORDS[k]}</option>)}
          </select>
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-body-dim">Who can post</span>
          <select className={select} aria-label="Who can post" value={post} onChange={(e) => setPost(e.target.value as PostRule)}>
            {(Object.keys(POST_WORDS) as PostRule[]).map((k) => <option key={k} value={k}>{POST_WORDS[k]}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-body-dim">Keep messages</span>
          <Choice label="Keep messages" options={[{ value: "forever", label: cap > 0 ? `Server limit (${cap} days)` : "Forever" }, { value: "days", label: "For a set time" }]}
            value={forever ? "forever" : "days"} onChange={(v) => setForever(v === "forever")} />
          {!forever && (
            <span className="flex items-center gap-1">
              <input className={`${input} w-16 basis-16 tabular-nums`} inputMode="numeric" value={days} aria-label="Days to keep messages"
                onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
              <span className="text-2xs text-muted">days, up to {keepMaxDays(cap)}</span>
            </span>
          )}
        </div>
        {canEncrypt && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-body-dim">Encrypted</span>
            <Toggle on={encrypted} onToggle={() => setEncrypted((v) => !v)} label="Encrypted" />
          </div>
        )}
        {encrypt && (
          <div className="rounded-md border border-edge p-2">
            <p className="text-xs text-body">Before you switch this on:</p>
            <ul data-costs className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-secondary">
              {ENCRYPTION_COSTS.map((c) => <li key={c}>{c}</li>)}
              {kind === "forum" && <li>{FORUM_ENCRYPTION_COST}</li>}
            </ul>
          </div>
        )}
        {!isNew && room.encrypted && <p className="text-xs text-muted">Encrypted. This was chosen when the channel was made and cannot be changed.</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btn} onClick={onCancel}>Cancel</button>
          <button type="submit" className={btn} disabled={!ok}>{isNew ? "Make channel" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
