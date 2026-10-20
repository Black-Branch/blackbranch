"use client";

// The DM window's host: mounted once in the chat column. It owns which conversation is showing,
// the queue of incoming ones waiting behind it, the composer binding (the send-to swap) and the
// incoming watch.
//
// One window at a time: an explicit open (/dm, Message, a pick) takes the window; an
// incoming conversation from someone else waits and slides up when the open one closes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { localpart } from "@/app/lib/matrixDisplay";
import { matrixHandle, onMatrixHandle } from "@/app/lib/matrixHandle";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { bindComposer, releaseComposer } from "@/app/lib/composerBinding";
import { onDmRequest, registerDmHost, type DmPerson } from "@/app/lib/dm/bus";
import { latestDmNudge, pingDm } from "@/app/lib/dm/api";
import { acceptInvite, encryptionCaution, ensureMatrix, openConversation, recentArrivals, watchArrivals, type Arrival } from "./dmMatrix";
import DmWindow, { type Convo } from "./DmWindow";

/** How long an unaccepted incoming window stays without interaction. */
const UNACCEPTED_MS = 60_000;
const QUEUE_MAX = 5;
/** How often a visible, signed-in page asks for its own DM nudges (GET /api/dm/ping). */
const NUDGE_POLL_MS = 5_000;

type State = { current: Convo | null; queue: Convo[] };

const personOf = (matrixId: string): DmPerson => ({ matrixId, username: localpart(matrixId), displayName: null });
const avatarOf = (matrixId: string) => `/api/avatar/user/${encodeURIComponent(matrixId)}`;
const windowId = (c: Convo) => `dm:${c.seq}`;

let seqs = 0;

export default function DmHost() {
  const [st, setSt] = useState<State>({ current: null, queue: [] });
  const { matrixId: me } = useMatrixIdentity();
  const current = st.current;

  useEffect(() => registerDmHost(), []);

  // The convo being shown, for the binding's release check (set before effects that read it).
  const currentRef = useRef<Convo | null>(null);
  useLayoutEffect(() => { currentRef.current = current; });
  // The shown window's own animated close (Window closeRef).
  const closeHandle = useRef<(() => void) | null>(null);

  const patch = useCallback((seq: number, p: Partial<Convo>) => {
    setSt((s) => (s.current?.seq === seq ? { ...s, current: { ...s.current, ...p } } : s));
  }, []);

  const closeCurrent = useCallback((seq: number) => {
    releaseComposer(`dm:${seq}`);
    setSt((s) => (s.current?.seq !== seq ? s : { current: s.queue[0] ?? null, queue: s.queue.slice(1) }));
  }, []);

  // ── an explicit open: /dm, the user card's Message, a pick ─────────────────────────────────
  const start = useCallback(async (person: DmPerson, text?: string) => {
    const seq = ++seqs;
    const needsStart = matrixHandle().status !== "ready";
    setSt((s) => ({
      current: { seq, person, phase: "loading", needsStart, incoming: false, accepted: true },
      queue: s.queue.filter((q) => q.person.matrixId !== person.matrixId),
    }));
    const ready = await ensureMatrix();
    if (!ready.ok) {
      patch(seq, { phase: "error", error: ready.reason === "signin" ? "Messages need you to sign in again." : "Messages aren't reachable right now — try again in a moment." });
      return;
    }
    try {
      const room = await openConversation(ready.client, person.matrixId);
      if (!room) { patch(seq, { phase: "error", error: "Couldn't open the conversation — try again." }); return; }
      if (text) {
        await ready.client.sendTextMessage(room.roomId, text);
        pingDm(person.matrixId);
      }
      patch(seq, { phase: "open", roomId: room.roomId, invite: false });
    } catch (e) {
      patch(seq, { phase: "error", error: e instanceof Error && e.message ? `Couldn't open the conversation: ${e.message}` : "Couldn't open the conversation." });
    }
  }, [patch]);

  useEffect(() => onDmRequest((r) => {
    if (r.kind === "open") { void start(r.to, r.text); return; }
    const seq = ++seqs;
    setSt((s) => ({
      ...s,
      current: { seq, person: { matrixId: "", username: r.query, displayName: null }, phase: "pick", people: r.people, text: r.text, incoming: false, accepted: false },
    }));
  }), [start]);

  // ── incoming ──────────────────────────────────────────────────────────────────────────────
  const arrive = useCallback((a: Arrival) => {
    setSt((s) => {
      if (s.current?.person.matrixId === a.partner) {
        if (s.current.roomId) return s;
        return { ...s, current: { ...s.current, roomId: a.roomId, invite: a.invite } };
      }
      if (s.queue.some((q) => q.person.matrixId === a.partner)) return s;
      const convo: Convo = { seq: ++seqs, person: personOf(a.partner), phase: "open", incoming: true, accepted: false, roomId: a.roomId, invite: a.invite };
      if (!s.current) return { ...s, current: convo };
      return { ...s, queue: [...s.queue, convo].slice(-QUEUE_MAX) };
    });
  }, []);

  // Watch the client whenever it is running — started by us, by a nudge, or by the Community tab.
  useEffect(() => {
    let watching: { client: unknown; off: () => void } | null = null;
    const attach = () => {
      const h = matrixHandle();
      const client = h.status === "ready" ? h.client : null;
      if (watching?.client === client) return;
      watching?.off();
      watching = client ? { client, off: watchArrivals(client, arrive) } : null;
    };
    attach();
    const off = onMatrixHandle(attach);
    return () => { off(); watching?.off(); };
  }, [arrive]);

  // The nudge: this page asks the server for its OWN pending nudges (never a public socket frame —
  // nudgeBox.ts) while the tab is visible; a stamp newer than the last one seen starts the client
  // and looks for what came. The first answer is only the baseline, as a socket frame from before
  // the page loaded was never seen either.
  useEffect(() => {
    if (!me) return;
    let seen: number | null = null;
    let alive = true;
    let asking = false;
    const poll = async () => {
      // A hidden tab waits (no background traffic) — except for the baseline, so a nudge that
      // lands while the tab is hidden still reads as new once it is shown.
      if (asking || (document.hidden && seen !== null)) return;
      asking = true;
      const at = await latestDmNudge();
      asking = false;
      if (!alive || at === null) return;
      if (seen !== null && at > seen) {
        void ensureMatrix().then((r) => { if (r.ok) for (const a of recentArrivals(r.client)) arrive(a); });
      }
      seen = Math.max(seen ?? 0, at);
    };
    void poll();
    const timer = setInterval(() => void poll(), NUDGE_POLL_MS);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [me, arrive]);

  // ── Accept ────────────────────────────────────────────────────────────────────────────────
  const accept = useCallback(async (c: Convo) => {
    if (!c.invite || !c.roomId) { patch(c.seq, { accepted: true }); return; }
    const ready = await ensureMatrix();
    if (!ready.ok) { patch(c.seq, { error: "Messages aren't reachable right now — try again." }); return; }
    try {
      await acceptInvite(ready.client, c.roomId, c.person.matrixId);
      patch(c.seq, { accepted: true, invite: false, error: undefined });
    } catch {
      patch(c.seq, { error: "Couldn't accept — try again." });
    }
  }, [patch]);

  // ── encryption line (read-only) ───────────────────────────────────────────────────────────
  const seq = current?.seq;
  const roomId = current?.roomId;
  const joined = !!roomId && !current?.invite && current?.phase === "open";
  const peer = current?.person.matrixId;
  const peerName = current?.person.username;
  useEffect(() => {
    if (seq === undefined || !joined || !roomId || !peer || !peerName) return;
    const client = matrixHandle().client;
    if (!client) return;
    let alive = true;
    encryptionCaution(client, roomId, peer, peerName)
      .then((caution) => { if (alive) patch(seq, { caution, encrypted: caution === null }); })
      .catch(() => { if (alive) patch(seq, { caution: "Couldn't check this conversation's encryption.", encrypted: false }); });
    return () => { alive = false; };
  }, [seq, joined, roomId, peer, peerName, patch]);

  // ── the send-to swap: an accepted, open conversation holds the chat box ───────────────────
  // Two effects on purpose: re-binding the SAME window (its colour arrives after the encryption
  // check) replaces the declaration, while only a change of WHICH conversation — or it stopping
  // being bindable — releases. One effect would release on every re-run, and a release from the
  // window that is showing closes it.
  const bindable = !!current && current.accepted && current.phase === "open" && !!current.roomId && !current.invite;
  const encrypted = current?.encrypted;
  useEffect(() => {
    if (!bindable || !current || !current.roomId) return;
    const c = current;
    const room = current.roomId;
    bindComposer({
      kind: "sendTo",
      windowId: windowId(c),
      face: {
        label: c.person.username,
        avatarUrl: avatarOf(c.person.matrixId),
        accent: encrypted === false ? "var(--color-red-400)" : "var(--color-encrypted)",
      },
      send: async (text) => {
        const client = matrixHandle().client;
        if (!client) throw new Error("Messages aren't connected — try again in a moment.");
        await client.sendTextMessage(room, text);
        pingDm(c.person.matrixId);
      },
      // The send-to button was pressed: the window slides away. A release that comes from this
      // window being replaced finds another convo showing and does nothing.
      onRelease: () => { if (currentRef.current?.seq === c.seq) closeHandle.current?.(); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-declare only when the bound conversation, its room or its colour changes; `current` itself changes on every patch
  }, [bindable, current?.seq, current?.roomId, encrypted]);
  useEffect(() => {
    if (!bindable || seq === undefined) return;
    return () => { releaseComposer(`dm:${seq}`); };
  }, [bindable, seq]);

  if (!current) return null;
  return (
    <DmWindow
      key={current.seq}
      convo={current}
      me={me}
      closeRef={closeHandle}
      autoDismissMs={current.incoming && !current.accepted ? UNACCEPTED_MS : undefined}
      onAccept={() => void accept(current)}
      onPick={(p) => void start(p, current.text)}
      onClose={() => closeCurrent(current.seq)}
    />
  );
}
