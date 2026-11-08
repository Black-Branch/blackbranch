"use client";

// One direct-message conversation in the chat column. The host
// (DmHost) owns the state; this draws it: the loading placeholder while the room is prepared, a
// short picker when a name matched several people, the conversation (DmConversation: the
// Community row — pictures, day dividers, media, reactions, reply quotes, our own failed lines
// marked "Not sent" with Retry/Delete), the "Replying to" strip, the red lines (encryption, the
// other person gone), and the request's answers: Accept · Decline · Block on an invite, Reply on a
// conversation already joined. Replies are typed in the chat box, which the host binds to this
// conversation once it is accepted.
// The band (Discord's DM header): their picture and presence dot, the name (a tap opens their user
// card), "+1 · name" when another conversation waits behind this one (a tap switches), and "Open in
// Community" (the full conversation in the Matrix tab). "<name> is typing…" is DmConversation's.

import { useRef, useState } from "react";
import nextDynamic from "next/dynamic";
import { ArrowsOutSimple, ChatCircle, DotsThree, LockSimple, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { BarButton, Window } from "@/app/components/chrome";
import { Avatar } from "@/app/components/Avatar";
import { MatchText } from "@/app/components/MatchText";
import { DmActionsMenu } from "@/app/components/DmActionsMenu";
import type { DmActions } from "@/app/lib/dmConversations";
import { PresenceDot } from "@/app/components/PresenceDot";
import { TimelineSkeleton } from "@/app/components/TimelineSkeleton";
import { getActiveTarget } from "@/app/lib/chrome/windowLayer";
import { MATRIX_READINESS_KEY, matrixHandle } from "@/app/lib/matrixHandle";
import { personOfMessage } from "@/app/lib/hideTarget";
import { usePresence, presenceOf, userSnapshotOf } from "@/app/lib/usePresence";
import { deriveState, presenceLine } from "@/app/lib/presenceState";
import { useMinuteTick } from "@/app/lib/useSetting";
import { requestOpenRoom, type DmPerson } from "@/app/lib/dm/bus";
import type { ReplyContext } from "@/app/lib/buildMatrixMessage";

// The conversation reaches matrix-js-sdk VALUES (the Community row's reply fetch); this window is
// mounted by the chat column on every page, so its chunk loads only when a conversation opens.
// Its placeholder is the area's own skeleton, so the chunk arriving is not a state of its own.
const DmConversation = nextDynamic(() => import("./DmConversation"), {
  ssr: false,
  loading: () => (
    <div data-mx-pane="narrow" className="relative -mx-3 min-h-0 flex-1"><TimelineSkeleton /></div>
  ),
});

export type Convo = {
  /** One per window instance — the window's key and its binding id. */
  seq: number;
  person: DmPerson;
  phase: "pick" | "loading" | "open" | "error";
  /** pick: who the name matched. */
  people?: DmPerson[];
  /** A message to send once the room is open (`/dm name text`), carried through a pick. */
  text?: string;
  /** loading: the client had to start, so the window shows its stages. */
  needsStart?: boolean;
  /** Opened by the other person (an invite or a message), not by this viewer. */
  incoming: boolean;
  accepted: boolean;
  roomId?: string;
  /** An invite this viewer has not joined yet: nothing can be read until Accept. */
  invite?: boolean;
  /** No room yet: opening made none; the first line (or "Send message request") makes it. */
  draft?: boolean;
  error?: string;
  /** The red line, or null when encryption is in force; undefined until checked. */
  caution?: string | null;
  encrypted?: boolean;
  /** "<name> isn't in this conversation" once they left; null while they are in it. */
  partnerCaution?: string | null;
  /** The result of Block, in plain words. */
  notice?: string;
  /** Blocked: the request is answered, so its buttons go. */
  blocked?: boolean;
  /** The room shown is not a private conversation (an accepted group invite, someone else joined):
   *  undefined until checked; only `false` lets the box hold it. */
  notPrivate?: boolean;
  /** The line the next send answers ("Replying to <name>"); cleared once a line is sent. */
  replyTo?: ReplyContext;
  /** A line typed for this conversation that could not go yet (the box let go by itself, or a
   *  refused `/dm name text`): shown here, and back in the chat box once the box holds this
   *  conversation again. Never posted to Live. */
  kept?: string;
};

/** Slide into the chat column when it is there to slide into; float when it is folded away. */
function usePresentation(): "panel" | "floating" {
  const [p] = useState<"panel" | "floating">(() => {
    const layer = getActiveTarget();
    return layer && layer.offsetWidth > 0 && layer.offsetHeight > 0 ? "panel" : "floating";
  });
  return p;
}

/** A conversation with no room yet: nothing has been made or sent. "Send message request" (no
 *  line) makes the room and the invite, behind a confirm — it reaches the other person. */
function Draft({ name, onRequest }: { name: string; onRequest: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const btn = "h-6 rounded-md px-2 text-xs font-semibold focus-visible:outline focus-visible:outline-edge-bright";
  return (
    <div className="flex flex-col items-start gap-2" data-dm-draft="">
      <p className="text-sm text-body">This is the start of your conversation with {name}. Type below to send them a message request.</p>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-body">Send {name} a message request?</span>
          <button type="button" onClick={() => { setConfirming(false); onRequest(); }} className={`${btn} bg-strong text-on-accent hover:brightness-110`}>Send</button>
          <button type="button" onClick={() => setConfirming(false)} className={`${btn} text-secondary hover:bg-raised hover:text-strong`}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`${btn} text-secondary hover:bg-raised hover:text-strong`}>
          Send message request
        </button>
      )}
    </div>
  );
}

/** The header's picture and presence dot (Discord's DM header): the person's Matrix picture (their
 *  letter without one) and the same dot the member list shows, its meaning on hover. */
function PersonMark({ person, roomId, encrypted }: { person: DmPerson; roomId?: string; encrypted?: boolean }) {
  const client = matrixHandle().client;
  const dir = usePresence();
  const now = useMinuteTick(true) * 60_000;
  const member = roomId ? client?.getRoom(roomId)?.getMember(person.matrixId) : null;
  const mxc = member?.getMxcAvatarUrl() ?? client?.getUser(person.matrixId)?.avatarUrl ?? null;
  const { state, lastActive } = deriveState(presenceOf(dir, person.matrixId), client ? userSnapshotOf(client, person.matrixId) : null, now);
  return (
    <>
      <span className="relative inline-flex shrink-0" data-dm-person="">
        <Avatar mxcUrl={mxc} name={person.username} size="sm" />
        <span className="absolute -bottom-0.5 -right-0.5 inline-flex">
          <PresenceDot state={state} size={8} title={presenceLine(state, lastActive, now)} />
        </span>
      </span>
      {encrypted ? <LockSimple size={12} weight="bold" aria-label="Encrypted" /> : null}
    </>
  );
}

export default function DmWindow({ convo, closeRef, autoDismissMs, onAccept, onDecline, onRequest, onStartPrivate, onBlock, onRetry, onDrop, onReply, onCancelReply, onPick, onClose, onOpenCard, typed, waiting, onSwitch, menuActions }: {
  convo: Convo;
  closeRef: { current: (() => void) | null };
  autoDismissMs?: number;
  onAccept: () => void;
  onDecline: () => void;
  /** A draft's "Send message request": the room and the invite, with no line. */
  onRequest: () => void;
  /** A room that is not private: leave it and start a private conversation (a draft). */
  onStartPrivate: () => void;
  onBlock: () => void;
  /** A "Not sent" line's Retry / Delete, by the line's (echo's) id. */
  onRetry: (id: string) => void;
  onDrop: (id: string) => void;
  /** A row's Reply (the strip shows it), and the strip's ✕. */
  onReply: (reply: ReplyContext) => void;
  onCancelReply: () => void;
  onPick: (p: DmPerson) => void;
  onClose: () => void;
  /** The header's name: open this person's user card. */
  onOpenCard?: () => void;
  /** The chat box's text while it holds this conversation (our typing goes out from it). */
  typed?: string;
  /** The first conversation waiting behind this one, and how many wait: the band's "+1 · name". */
  waiting?: { person: DmPerson; count: number } | null;
  onSwitch?: () => void;
  /** The conversation's menu (Pin · Close · Leave), read when it opens; null when there is none. */
  menuActions?: () => DmActions | null;
}) {
  const presentation = usePresentation();
  const name = convo.person.username;
  const picking = convo.phase === "pick";
  // A picker has no one person yet: the plain mark.
  const mark = picking || !convo.person.matrixId
    ? <ChatCircle size={14} weight="bold" />
    : <PersonMark person={convo.person} roomId={convo.roomId} encrypted={convo.encrypted} />;
  // Block needs someone to hide; with no id to hide by, the request can still be declined.
  const blockable = !!personOfMessage({ username: name, matrixId: convo.person.matrixId || null });
  const answering = convo.phase === "open" && convo.incoming && !convo.accepted && !convo.blocked;
  // The conversation itself shows: a room joined and opened (not a request, a draft or an error).
  const talking = !picking && convo.phase !== "error" && !(convo.draft && !convo.roomId) && !convo.invite && !!convo.roomId;
  const roomId = convo.roomId;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; actions: DmActions } | null>(null);
  const openMenu = () => {
    const a = menuActions?.();
    const r = moreRef.current?.getBoundingClientRect();
    if (a && r) setMenu((m) => (m ? null : { x: r.right - 244, y: r.bottom + 4, actions: a }));
  };

  const actions = (
    <>
      {waiting && onSwitch && (
        <button type="button" onClick={onSwitch} data-dm-waiting=""
          aria-label={`Switch to ${waiting.person.username}'s conversation (${waiting.count} waiting)`}
          className="flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-full bg-raised pl-0.5 pr-2 text-2xs font-semibold text-strong hover:brightness-110 focus-visible:outline focus-visible:outline-edge-bright">
          <img src={`/api/avatar/user/${encodeURIComponent(waiting.person.matrixId)}`} alt="" aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full object-cover" />
          <span className="truncate">{`+${waiting.count} · ${waiting.person.username}`}</span>
        </button>
      )}
      {talking && roomId && (
        <BarButton icon={<ArrowsOutSimple size={13} weight="bold" />} label="Open in Community" onClick={() => requestOpenRoom(roomId)} />
      )}
      {talking && menuActions && (
        <BarButton ref={moreRef} icon={<DotsThree size={14} weight="bold" />} label="Conversation options" expanded={!!menu} onClick={openMenu} />
      )}
    </>
  );

  return (
    <Window
      presentation={presentation}
      kind="peek"
      name={picking ? "Message who?" : `Direct messages with ${name}`}
      mark={mark}
      title={picking ? "Message who?" : name}
      onTitle={!picking && convo.person.matrixId ? onOpenCard : undefined}
      actions={actions}
      defaultSize={{ w: 360, h: 320 }}
      fitHeight
      closeRef={closeRef}
      autoDismissMs={autoDismissMs ?? (convo.phase === "error" ? 10_000 : undefined)}
      loading={convo.phase === "loading" ? {
        height: 96,
        label: `Opening the conversation with ${name}`,
        readiness: convo.needsStart ? [MATRIX_READINESS_KEY] : undefined,
      } : null}
      onClose={onClose}
    >
      {/* data-scroll-inner while the conversation shows: the window body becomes a frame and the
          list inside it is the scroller, as tall as the panel is (a taller panel shows more). */}
      <div className={`flex flex-col gap-2 p-3${talking ? " min-h-0" : ""}`} data-dm-window={convo.phase} data-scroll-inner={talking ? "" : undefined}>
        {convo.caution && (
          <p role="note" className="flex items-start gap-1.5 text-xs text-red-400" data-dm-caution="">
            <WarningCircle size={14} weight="bold" className="mt-px shrink-0" aria-hidden="true" />
            <span>{convo.caution}</span>
          </p>
        )}
        {convo.partnerCaution && (
          <p role="note" className="text-xs text-red-400" data-dm-partner-caution="">{convo.partnerCaution}</p>
        )}
        {convo.notPrivate === true && convo.accepted && (
          <div role="note" className="flex flex-wrap items-center gap-2 text-xs" data-dm-not-private="">
            <span className="text-red-400">This isn&apos;t a private conversation — others are in it, so your lines aren&apos;t sent here.</span>
            <button type="button" onClick={onStartPrivate}
              className="h-6 rounded-md px-2 text-xs font-semibold text-secondary hover:bg-raised hover:text-strong focus-visible:outline focus-visible:outline-edge-bright">
              Start a private conversation
            </button>
          </div>
        )}
        {picking ? (
          <>
            <p className="text-xs text-secondary">Who do you mean by “{name}”?</p>
            <ul className="flex flex-col gap-1">
              {(convo.people ?? []).map((p) => (
                <li key={p.matrixId}>
                  <button type="button" onClick={() => onPick(p)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-raised focus-visible:outline focus-visible:outline-edge-bright">
                    <img src={`/api/avatar/user/${encodeURIComponent(p.matrixId)}`} alt="" className="h-6 w-6 rounded-full object-cover" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-heading"><MatchText text={p.displayName || p.username} query={name} /></span>
                      {/* The full id: two accounts can share a name (another server's), and this says which. */}
                      <span className="truncate text-2xs text-muted" data-dm-pick-id=""><MatchText text={p.matrixId} query={name} /></span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : convo.phase === "error" ? (
          <p className="text-sm text-red-400" role="alert">{convo.error}</p>
        ) : convo.draft && !convo.roomId ? (
          <Draft name={name} onRequest={onRequest} />
        ) : convo.invite || !convo.roomId ? (
          <p className="text-sm text-body">{name} wants to send you messages.</p>
        ) : (
          <DmConversation roomId={convo.roomId} peerName={name} accepted={convo.accepted} typed={typed ?? ""} onReply={onReply} onRetry={onRetry} onDrop={onDrop} />
        )}
        {talking && convo.accepted && convo.replyTo && (
          <div data-dm-reply="" className="flex items-center gap-2 text-xs text-muted">
            <span className="min-w-0 truncate">↩ Replying to <span className="text-body-dim">{convo.replyTo.senderLabel}</span></span>
            <button type="button" onClick={onCancelReply} aria-label="Cancel reply"
              className="ml-auto shrink-0 text-muted hover:text-secondary focus-visible:outline focus-visible:outline-edge-bright">
              ✕
            </button>
          </div>
        )}
        {convo.phase !== "error" && convo.error && <p className="text-xs text-red-400" role="alert">{convo.error}</p>}
        {convo.notice && <p className="text-xs text-secondary" role="status">{convo.notice}</p>}
        {convo.kept && (
          <p className="text-xs text-secondary break-words" role="status" data-dm-kept="">
            Not sent yet, kept for {name}: “{convo.kept}”
          </p>
        )}
        {menu && (
          <DmActionsMenu name={name} actions={menu.actions} x={menu.x} y={menu.y} onDismiss={() => setMenu(null)} anchorRef={moreRef} />
        )}
        {answering && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onAccept}
              className="h-6 rounded-md bg-strong px-3 text-xs font-semibold text-on-accent hover:brightness-110 focus-visible:outline focus-visible:outline-edge-bright">
              {convo.invite ? "Accept" : "Reply"}
            </button>
            {convo.invite && (
              <>
                <button type="button" onClick={onDecline}
                  className="h-6 rounded-md px-2 text-xs font-semibold text-secondary hover:bg-raised hover:text-strong focus-visible:outline focus-visible:outline-edge-bright">
                  Decline
                </button>
                {blockable && (
                  <button type="button" onClick={onBlock}
                    className="h-6 rounded-md px-2 text-xs font-semibold text-red-400 hover:bg-raised focus-visible:outline focus-visible:outline-edge-bright">
                    Block
                  </button>
                )}
              </>
            )}
            {/* A window holding a kept line never closes by itself (DmHost), so it does not say so. */}
            {!convo.kept && <span className="text-2xs text-muted">Closes in a minute unless you {convo.invite ? "accept" : "reply"}.</span>}
          </div>
        )}
      </div>
    </Window>
  );
}
