"use client";

// One direct-message conversation in the chat column. The host
// (DmHost) owns the state; this draws it: the loading placeholder while the room is prepared, a
// short picker when a name matched several people, the conversation's lines, the red encryption
// line, and Accept for an incoming conversation. Replies are typed in the chat box, which the
// host binds to this conversation once it is accepted.

import { useEffect, useRef, useState } from "react";
import { ChatCircle, LockSimple, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { Window } from "@/app/components/chrome";
import { getActiveTarget } from "@/app/lib/chrome/windowLayer";
import { MATRIX_READINESS_KEY, matrixHandle } from "@/app/lib/matrixHandle";
import { localpart } from "@/app/lib/matrixDisplay";
import type { DmLine } from "@/app/lib/matrixDm";
import type { DmPerson } from "@/app/lib/dm/bus";
import { followLines } from "./dmMatrix";

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
  error?: string;
  /** The red line, or null when encryption is in force; undefined until checked. */
  caution?: string | null;
  encrypted?: boolean;
};

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Slide into the chat column when it is there to slide into; float when it is folded away. */
function usePresentation(): "panel" | "floating" {
  const [p] = useState<"panel" | "floating">(() => {
    const layer = getActiveTarget();
    return layer && layer.offsetWidth > 0 && layer.offsetHeight > 0 ? "panel" : "floating";
  });
  return p;
}

function Lines({ roomId, me, peerName }: { roomId: string; me: string | null; peerName: string }) {
  const [lines, setLines] = useState<DmLine[]>([]);
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const client = matrixHandle().client;
    if (!client) return;
    return followLines(client, roomId, setLines);
  }, [roomId]);
  // Newest at the bottom. scrollTop on the list itself — scrollIntoView would also scroll the
  // panel's clipped layer and the page.
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [lines]);
  if (!lines.length) return <p className="text-xs text-muted">No messages yet — type in the chat box below to say something.</p>;
  return (
    <ol ref={list} className="flex max-h-64 flex-col gap-1 overflow-y-auto no-scrollbar" aria-label={`Conversation with ${peerName}`}>
      {lines.map((l, i) => (
        <li key={`${l.ts}-${i}`} className="text-chat-sm leading-snug break-words">
          <span className="text-2xs text-muted tabular-nums">{time(l.ts)}</span>{" "}
          <span className="font-semibold text-heading">{l.fromId === me ? "you" : localpart(l.fromId)}</span>{" "}
          {l.undecryptable
            ? <span className="italic text-muted">can&apos;t be read on this device</span>
            : <span className="text-body whitespace-pre-wrap">{l.text}</span>}
        </li>
      ))}
    </ol>
  );
}

export default function DmWindow({ convo, me, closeRef, autoDismissMs, onAccept, onPick, onClose }: {
  convo: Convo;
  me: string | null;
  closeRef: { current: (() => void) | null };
  autoDismissMs?: number;
  onAccept: () => void;
  onPick: (p: DmPerson) => void;
  onClose: () => void;
}) {
  const presentation = usePresentation();
  const name = convo.person.username;
  const picking = convo.phase === "pick";
  const mark = convo.encrypted ? <LockSimple size={14} weight="bold" /> : <ChatCircle size={14} weight="bold" />;

  return (
    <Window
      presentation={presentation}
      kind="peek"
      name={picking ? "Message who?" : `Direct messages with ${name}`}
      mark={mark}
      title={picking ? "Message who?" : name}
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
      <div className="flex flex-col gap-2 p-3" data-dm-window={convo.phase}>
        {convo.caution && (
          <p role="note" className="flex items-start gap-1.5 text-xs text-red-400" data-dm-caution="">
            <WarningCircle size={14} weight="bold" className="mt-px shrink-0" aria-hidden="true" />
            <span>{convo.caution}</span>
          </p>
        )}
        {picking ? (
          <>
            <p className="text-xs text-secondary">More than one person matches “{name}”:</p>
            <ul className="flex flex-col gap-1">
              {(convo.people ?? []).map((p) => (
                <li key={p.matrixId}>
                  <button type="button" onClick={() => onPick(p)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-raised focus-visible:outline focus-visible:outline-edge-bright">
                    <img src={`/api/avatar/user/${encodeURIComponent(p.matrixId)}`} alt="" className="h-6 w-6 rounded-full object-cover" />
                    <span className="text-sm text-heading">{p.username}</span>
                    {p.displayName && p.displayName !== p.username && <span className="truncate text-xs text-muted">{p.displayName}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : convo.phase === "error" ? (
          <p className="text-sm text-red-400" role="alert">{convo.error}</p>
        ) : convo.invite || !convo.roomId ? (
          <p className="text-sm text-body">{name} wants to send you messages.</p>
        ) : (
          <Lines roomId={convo.roomId} me={me} peerName={name} />
        )}
        {convo.phase !== "error" && convo.error && <p className="text-xs text-red-400" role="alert">{convo.error}</p>}
        {convo.phase === "open" && convo.incoming && !convo.accepted && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={onAccept}
              className="h-6 rounded-md bg-strong px-3 text-xs font-semibold text-on-accent hover:brightness-110 focus-visible:outline focus-visible:outline-edge-bright">
              Accept
            </button>
            <span className="text-2xs text-muted">Closes in a minute unless you accept.</span>
          </div>
        )}
      </div>
    </Window>
  );
}
