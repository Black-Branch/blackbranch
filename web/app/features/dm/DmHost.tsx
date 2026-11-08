"use client";

// The DM window's host: mounted once in the chat column. It owns which conversation is showing,
// the queue of incoming ones waiting behind it, the composer binding (the send-to swap) and the
// incoming watch.
//
// One window at a time: an explicit open (/dm, Message, a pick) takes the window; an
// incoming conversation from someone else waits and slides up when the open one closes, or when
// the band's "+1 · name" is tapped (the one showing then waits behind, its typed line with it). Nothing
// opens over the conversation already on screen in the Community timeline (lib/dm/bus.ts).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { matrixHandle, onMatrixHandle } from "@/app/lib/matrixHandle";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { bindComposer, releaseComposer } from "@/app/lib/composerBinding";
import { onDmRequest, registerDmHost, roomOnScreen, type DmPerson } from "@/app/lib/dm/bus";
import { latestDmNudge, pingDm } from "@/app/lib/dm/api";
import { NOT_PRIVATE, partnerMembership, roomForSending, SEND_FAILED, strictlyOurs } from "@/app/lib/matrixDm";
import { declineInvite } from "@/app/lib/matrixInvites";
import { dropEcho } from "@/app/lib/localEcho";
import { personOfMessage } from "@/app/lib/hideTarget";
import { buildMatrixMessage } from "@/app/lib/buildMatrixMessage";
import { currentEmotes } from "@/app/lib/useEmotes";
import { liveViewer } from "@/app/lib/liveDirectory";
import {
  acceptInvite, encryptionCaution, ensureMatrix, onPartnerChange, openThenSend, partnerLeftCaution,
  recentArrivals, retryDmLine, sendDmLine, watchArrivals, type Arrival,
} from "./dmMatrix";
import { arriveInto, isBindable, keepsLine, keepWaiting, switchToWaiting, type DmState } from "./dmQueue";
import { blockRequest } from "./requestActions";
import { conversationActions, conversationWith } from "@/app/lib/dmConversations";
import DmWindow, { type Convo } from "./DmWindow";

/** How long an unaccepted incoming window stays without interaction. */
const UNACCEPTED_MS = 60_000;
/** How often a visible, signed-in page asks for its own DM nudges (GET /api/dm/ping). */
const NUDGE_POLL_MS = 5_000;

const avatarOf = (matrixId: string) => `/api/avatar/user/${encodeURIComponent(matrixId)}`;
const windowId = (c: Convo) => `dm:${c.seq}`;

let seqs = 0;
const nextSeq = () => ++seqs;

export default function DmHost({ onOpenCard }: {
  /** The header's name: the chat column opens this person's user card. */
  onOpenCard: (who: { matrixId: string; username: string }) => void;
}) {
  const [st, setSt] = useState<DmState>({ current: null, queue: [] });
  const { matrixId: me } = useMatrixIdentity();
  const current = st.current;
  // The chat box's text while it holds the window showing (our typing goes out from it).
  const [typed, setTyped] = useState<{ seq: number; text: string } | null>(null);

  useEffect(() => registerDmHost(), []);

  // The convo being shown and the whole state, for the binding's release check (set before the
  // effects that read them).
  const currentRef = useRef<Convo | null>(null);
  const stRef = useRef<DmState>(st);
  useLayoutEffect(() => { currentRef.current = current; stRef.current = st; });
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
    const seq = nextSeq();
    const needsStart = matrixHandle().status !== "ready";
    setSt((s) => {
      // A conversation with them waiting behind (switched away) gives up its place, not its kept line.
      const kept = s.queue.find((q) => q.person.matrixId === person.matrixId)?.kept;
      return {
        current: { seq, person, phase: "loading", needsStart, incoming: false, accepted: true, ...(kept ? { kept } : {}) },
        queue: s.queue.filter((q) => q.person.matrixId !== person.matrixId),
      };
    });
    const ready = await ensureMatrix();
    if (!ready.ok) {
      patch(seq, { phase: "error", error: ready.reason === "signin" ? "Messages need you to sign in again." : "Messages aren't reachable right now — try again in a moment." });
      return;
    }
    try {
      // Opening makes nothing: no room, no request, until a line is sent (or the request confirmed).
      // With text (`/dm name text`) the window opens first, then the line goes; a refusal keeps it.
      const r = await openThenSend(ready.client, person.matrixId, text, (p) => patch(seq, p), currentEmotes());
      if (r === "sent") pingDm(person.matrixId);
    } catch (e) {
      // Plain words for the person; the SDK's own text (an M_ code, a URL) goes to the console
      // only, never onto the screen (polish handoff A8).
      console.warn("[dm] could not open the conversation:", e);
      patch(seq, { phase: "error", error: "Couldn't open the conversation — try again in a moment." });
    }
  }, [patch]);

  useEffect(() => onDmRequest((r) => {
    if (r.kind === "open") { void start(r.to, r.text); return; }
    const seq = nextSeq();
    setSt((s) => ({
      ...s,
      current: { seq, person: { matrixId: "", username: r.query, displayName: null }, phase: "pick", people: r.people, text: r.text, incoming: false, accepted: false },
    }));
  }), [start]);

  // ── incoming ──────────────────────────────────────────────────────────────────────────────
  const arrive = useCallback((a: Arrival) => {
    const onScreen = roomOnScreen();
    setSt((s) => arriveInto(s, a, onScreen, nextSeq));
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

  // ── Accept / Reply, Decline, Block ────────────────────────────────────────────────────────
  // Accept (a request) or Reply (a joined room). Either way the room is held to the strict rule
  // before the box can hold it: a group conversation shows what it is instead (notPrivate).
  const accept = useCallback(async (c: Convo) => {
    if (!c.roomId) { patch(c.seq, { accepted: true }); return; }
    const ready = await ensureMatrix();
    if (!ready.ok) { patch(c.seq, { error: "Messages aren't reachable right now — try again." }); return; }
    try {
      if (c.invite) await acceptInvite(ready.client, c.roomId);
      const room = ready.client.getRoom(c.roomId);
      const ok = !!room && await strictlyOurs(ready.client, room, c.person.matrixId);
      patch(c.seq, { accepted: true, invite: false, error: undefined, notPrivate: !ok });
    } catch {
      patch(c.seq, { error: c.invite ? "Couldn't accept — try again." : "Couldn't open the conversation — try again." });
    }
  }, [patch]);

  const decline = useCallback(async (c: Convo) => {
    const ready = await ensureMatrix();
    if (!ready.ok || !c.roomId) { patch(c.seq, { error: "Messages aren't reachable right now — try again." }); return; }
    try {
      await declineInvite(ready.client, c.roomId);
      closeHandle.current?.();
    } catch (e) {
      console.warn("[dm] could not decline:", e);
      patch(c.seq, { error: "Couldn't decline — try again." });
    }
  }, [patch]);

  // "Send message request" on a conversation with no room yet: the room and the invite, no line.
  const request = useCallback(async (c: Convo) => {
    const ready = await ensureMatrix();
    if (!ready.ok) { patch(c.seq, { error: "Messages aren't reachable right now — try again." }); return; }
    try {
      const room = await roomForSending(ready.client, c.person.matrixId);
      patch(c.seq, { roomId: room.roomId, draft: false, error: undefined, notPrivate: false });
      pingDm(c.person.matrixId);
    } catch {
      patch(c.seq, { error: "Couldn't send the request — try again." });
    }
  }, [patch]);

  const block = useCallback(async (c: Convo) => {
    const target = personOfMessage({ username: c.person.username, matrixId: c.person.matrixId });
    if (!target) return;
    const roomId = c.roomId;
    const { line, blocked } = await blockRequest(target, { matrixId: me, ownIds: liveViewer().ownIds }, async () => {
      const ready = await ensureMatrix();
      if (ready.ok && roomId) await declineInvite(ready.client, roomId);
    });
    patch(c.seq, { notice: line, blocked });
  }, [me, patch]);

  // ── a line's Retry / Delete (its echo, found by id in the live timeline) ──────────────────
  const roomIdNow = current?.roomId;
  const partnerNow = current?.person.matrixId;
  const seqNow = current?.seq;
  const retryLine = useCallback(async (id: string) => {
    const client = matrixHandle().client;
    if (!client || !roomIdNow || !partnerNow) return;
    // A resend is a send: refused (nothing sent) if the conversation is not private any more.
    const r = await retryDmLine(client, roomIdNow, partnerNow, id);
    if (r === "refused" && seqNow !== undefined) patch(seqNow, { error: NOT_PRIVATE });
    if (r === "sent") pingDm(partnerNow);
  }, [roomIdNow, partnerNow, seqNow, patch]);
  const dropLine = useCallback((id: string) => {
    const client = matrixHandle().client;
    const ev = roomIdNow ? client?.getRoom(roomIdNow)?.findEventById(id) : null;
    if (client && ev) dropEcho(client, ev);
  }, [roomIdNow]);

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

  // ── the other person left: say so, and keep saying it while the window is open ────────────
  useEffect(() => {
    if (seq === undefined || !joined || !roomId || !peer || !peerName) return;
    const client = matrixHandle().client;
    const room = client?.getRoom(roomId);
    if (!client || !room) return;
    const person: DmPerson = { matrixId: peer, username: peerName, displayName: null };
    let alive = true;
    // The other person gone, and whether this is a private conversation at all (an accepted group
    // invite is not): a room that is not private never holds the box (isBindable).
    const check = () => {
      if (!alive) return;
      patch(seq, { partnerCaution: partnerLeftCaution(room, person) });
      void strictlyOurs(client, room, peer).then((ok) => { if (alive) patch(seq, { notPrivate: !ok }); }, () => {});
    };
    // Members are lazy-loaded: load them before the first answer.
    void partnerMembership(room, peer).then(check, () => {});
    const off = onPartnerChange(client, roomId, check);
    return () => { alive = false; off(); };
  }, [seq, joined, roomId, peer, peerName, patch]);

  // ── the send-to swap: an accepted, open conversation holds the chat box ───────────────────
  // Two effects on purpose: re-binding the SAME window (its colour arrives after the encryption
  // check) replaces the declaration, while only a change of WHICH conversation — or it stopping
  // being bindable — releases. One effect would release on every re-run, and a release from the
  // window that is showing closes it.
  // A draft (no room yet) holds the box too: its first line makes the room.
  const bindable = !!current && isBindable(current);
  const encrypted = current?.encrypted;
  // A line kept while the box was away is handed back by re-declaring (watchBoundText takes it).
  const hasKept = !!current?.kept;
  useEffect(() => {
    if (!bindable || !current) return;
    const c = current;
    bindComposer({
      kind: "sendTo",
      windowId: windowId(c),
      face: {
        label: c.person.username,
        avatarUrl: avatarOf(c.person.matrixId),
        accent: encrypted === false ? "var(--color-red-400)" : "var(--color-encrypted)",
      },
      // Resolves once the line is in the conversation, sent or "Not sent" (the box clears; the
      // line holds the text and Retry). Throws only when no line was made.
      // The room is looked up (or, for the first line, made) at send time, one at a time per person.
      send: async (text) => {
        const client = matrixHandle().client;
        if (!client) throw new Error(SEND_FAILED);
        // The room on screen if there is one (never another), else the draft's first line makes it.
        const shown = currentRef.current?.seq === c.seq ? currentRef.current.roomId : c.roomId;
        const room = await roomForSending(client, c.person.matrixId, shown);
        // roomForSending passed the strict check: the box keeps holding this conversation.
        if (room.roomId !== shown) patch(c.seq, { roomId: room.roomId, draft: false, notPrivate: false });
        // The line answers the reply the strip shows — in this room only (a fresh room holds no
        // line to answer). Emotes and markdown as the Community composer sends them.
        const now = currentRef.current;
        const reply = now?.seq === c.seq && now.replyTo?.roomId === room.roomId ? now.replyTo : undefined;
        const sent = await sendDmLine(client, room.roomId, buildMatrixMessage(text, currentEmotes(), reply));
        // The line is in the conversation (sent, or "Not sent" with Retry): the reply went with it.
        if (reply) patch(c.seq, { replyTo: undefined });
        if (sent) pingDm(c.person.matrixId);
      },
      // The send-to button was pressed: the window slides away. A release that comes from this
      // window being replaced finds another convo showing and does nothing; one that comes from
      // this conversation changing in place (a draft whose person wrote first is now their request)
      // finds it no longer bindable and leaves the window open.
      onRelease: () => { const now = currentRef.current; if (now?.seq === c.seq && isBindable(now)) closeHandle.current?.(); },
      // The box let go by itself (their request on my draft, someone joined): the text typed for
      // this conversation moves here and the box is emptied — it never goes to Live on Enter.
      keep: (text) => {
        if (keepsLine(currentRef.current, c.seq)) { patch(c.seq, { kept: text }); return true; }
        // Switched away by the band's "+1 · name": the text waits with the conversation.
        if (!keepWaiting(stRef.current, c.seq, text)) return false;
        setSt((s) => keepWaiting(s, c.seq, text) ?? s);
        return true;
      },
      // Holding the box again (Accept, Reply, Start a private conversation): the kept line goes back.
      takeKept: () => {
        const now = currentRef.current;
        const kept = now?.seq === c.seq ? now.kept : undefined;
        if (kept) patch(c.seq, { kept: undefined });
        return kept;
      },
      onText: (text) => setTyped({ seq: c.seq, text }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-declare only when the bound conversation, its room, its colour or a kept line changes; `current` itself changes on every patch
  }, [bindable, current?.seq, current?.roomId, encrypted, hasKept]);
  useEffect(() => {
    if (!bindable || seq === undefined) return;
    return () => { releaseComposer(`dm:${seq}`); };
  }, [bindable, seq]);

  // Typing goes out only for the conversation holding the box, and a command is not a line to them.
  const typedNow = typed && typed.seq === current?.seq && bindable && !typed.text.startsWith("/") ? typed.text : "";
  const next = st.queue[0];

  if (!current) return null;
  return (
    <DmWindow
      key={current.seq}
      convo={current}
      closeRef={closeHandle}
      autoDismissMs={current.incoming && !current.accepted && !current.kept ? UNACCEPTED_MS : undefined}
      onAccept={() => void accept(current)}
      onDecline={() => void decline(current)}
      onStartPrivate={() => patch(current.seq, { roomId: undefined, draft: true, notPrivate: undefined, invite: false, accepted: true, caution: undefined, partnerCaution: undefined, encrypted: undefined })}
      onRequest={() => void request(current)}
      onBlock={() => void block(current)}
      onRetry={(id) => void retryLine(id)}
      onDrop={dropLine}
      onReply={(replyTo) => patch(current.seq, { replyTo })}
      onCancelReply={() => patch(current.seq, { replyTo: undefined })}
      onPick={(p) => void start(p, current.text)}
      onClose={() => closeCurrent(current.seq)}
      onOpenCard={() => onOpenCard({ matrixId: current.person.matrixId, username: current.person.username })}
      typed={typedNow}
      waiting={next ? { person: next.person, count: st.queue.length } : null}
      onSwitch={() => setSt(switchToWaiting)}
      menuActions={() => {
        // Read when the menu opens: the pin state and the rooms are the client's as of now.
        const client = matrixHandle().client;
        const own = client?.getUserId();
        const conv = client && own ? conversationWith(client, own, current.person.matrixId) : null;
        if (!client || !conv) return null;
        const base = conversationActions(client, conv);
        // Close and Leave also put the window away: the conversation is out of the list.
        return {
          ...base,
          onHide: async () => { await base.onHide(); closeHandle.current?.(); },
          onLeave: async () => { await base.onLeave(); closeHandle.current?.(); },
        };
      }}
    />
  );
}
