"use client";

import { useEffect, useRef, useState } from "react";
import { EventType } from "matrix-js-sdk";
import type { MatrixEvent, TimelineEvents } from "matrix-js-sdk";
import { useMatrixClient, useStartMatrixClient, MATRIX_READINESS_KEY } from "@/app/lib/MatrixClientContext";
import { BootSequence, Window } from "@/app/components/chrome";
import { MatrixInput } from "@/app/components/MatrixInput";
import { buildMatrixMessage } from "@/app/lib/buildMatrixMessage";
import { threadRelation } from "@/app/lib/matrixThreads";
import { useEmotes } from "@/app/lib/useEmotes";
import { postJson } from "@/app/lib/http";
import { dropEcho, echoState, localEchoOf, retryEcho } from "@/app/lib/localEcho";
import { NotSentLine } from "@/app/components/NotSentLine";
import type { ForumAction } from "@/app/lib/forumModel";
import { matrixServerName } from "@/app/lib/matrixConfig";
import { NewPostModal } from "./NewPostModal";

// Forum ACTIONS from the Forums tab: reading never boots the client;
// a signed-in viewer's New Post / Reply mounts this, which starts the client
// (deliberate intent — an allowlisted starter in matrixIdentity.test.ts),
// shows the boot sequence until the room is in the store, joins it if the
// viewer is not a member yet, then renders the same NewPostModal the Matrix
// pane uses, or a thread composer that sends exactly what ThreadPanel sends.
// Loaded with next/dynamic by the tab, so the SDK stays off its static graph.
const BOOT_KEYS = [MATRIX_READINESS_KEY] as const;

export function ForumActionHost({ action, onDone, onClose }: {
  action: ForumAction;
  /** The new event's id (null when the send answered without one). */
  onDone: (eventId: string | null) => void;
  onClose: () => void;
}) {
  useStartMatrixClient();
  const { client, status, retry } = useMatrixClient();
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const joining = useRef(false);
  const room = client?.getRoom(action.roomId) ?? null;
  const member = room?.getMyMembership() === "join";

  useEffect(() => {
    if (!client || status !== "ready" || member || joining.current) return;
    joining.current = true;
    client.joinRoom(action.roomId, { viaServers: [matrixServerName()] })
      .then(() => setJoined(true))
      .catch((e: unknown) => setJoinError(e instanceof Error ? e.message : "Couldn't join this forum"))
      .finally(() => { joining.current = false; });
  }, [client, status, member, action.roomId]);

  if (!client || status !== "ready" || !room || (!member && !joined)) {
    return (
      <Window presentation="dialog" name="Forum" title={action.kind === "post" ? "New post" : "Reply"} onClose={onClose} width={420}>
        <div className="p-5">
          {joinError
            ? <p className="text-sm text-secondary">{joinError}</p>
            : <BootSequence keys={BOOT_KEYS} label="Preparing to post" onRetry={retry} />}
        </div>
      </Window>
    );
  }
  if (action.kind === "post") {
    return <NewPostModal room={room} onClose={onClose} onPosted={(id) => onDone(id)} />;
  }
  return (
    <ReplyComposer
      roomId={action.roomId}
      rootId={action.rootId}
      latestId={action.latestId}
      rootSenderName={action.rootSenderName}
      onDone={onDone}
      onClose={onClose}
    />
  );
}

function ReplyComposer({ roomId, rootId, latestId, rootSenderName, onDone, onClose }: {
  roomId: string; rootId: string; latestId: string; rootSenderName: string;
  onDone: (id: string | null) => void; onClose: () => void;
}) {
  const { client } = useMatrixClient();
  const emotes = useEmotes();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // A reply that did not reach the server: kept here with Retry/Delete, never put back in the box
  // (a second press would send it twice) — the community's one rule for a failed send.
  const [failed, setFailed] = useState<{ ev: MatrixEvent; body: string } | null>(null);
  const [, rerender] = useState(0);
  const room = client?.getRoom(roomId) ?? undefined;
  const posted = (nid: string | null) => {
    // Reddit-style: your own comment starts auto-upvoted (+1, immutable).
    if (nid) postJson("/api/forum/vote", { roomId, eventId: nid, vote: 1 }).catch(() => {});
    onDone(nid);
  };
  const send = async () => {
    const body = input.trim();
    if (!client || !body || sending || failed) return;
    setSending(true);
    setInput("");
    const txnId = client.makeTxnId();
    try {
      // The same relation ThreadPanel writes: tied to the root, falling back as
      // a reply to the latest event so plain clients still show it in context.
      const content = buildMatrixMessage(body, emotes) as Record<string, unknown>;
      content["m.relates_to"] = threadRelation(rootId, latestId);
      const res = await client.sendEvent(roomId, EventType.RoomMessage, content as unknown as TimelineEvents[EventType.RoomMessage], txnId);
      posted(res?.event_id ?? null);
    } catch (e) {
      console.error("forum reply failed", e);
      const echo = room ? localEchoOf(room, txnId) : null;
      // No echo means nothing was made: then, and only then, the text goes back in the box.
      if (echo) setFailed({ ev: echo, body });
      else setInput(body);
    } finally {
      setSending(false);
    }
  };
  const retry = async () => {
    if (!client || !room || !failed) return;
    setSending(true);
    await retryEcho(client, room, failed.ev);
    setSending(false);
    if (echoState(failed.ev) === "sent") posted(failed.ev.getId() ?? null);
    else rerender((n) => n + 1);
  };
  const drop = () => {
    if (!client || !failed) return;
    dropEcho(client, failed.ev);
    setFailed(null);
  };
  return (
    <Window presentation="dialog" name="Reply" title={`Reply to ${rootSenderName}'s thread`} onClose={onClose} width={512}>
      <form className="p-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {failed && (
          <div className="mb-3">
            <p className="text-body opacity-60 whitespace-pre-wrap break-words" style={{ fontSize: "var(--text-chat-sm)" }}>{failed.body}</p>
            {echoState(failed.ev) === "failed" && <NotSentLine onRetry={() => void retry()} onDelete={drop} />}
          </div>
        )}
        <MatrixInput
          value={input}
          onChange={setInput}
          onSubmit={() => { void send(); }}
          placeholder={`Reply to ${rootSenderName}'s thread…`}
          // One reply per dialog: a failed one is retried or deleted first.
          disabled={sending || !!failed}
          isSignedIn
          hideUserMenu
          room={room}
          // A file reply is a reply, not a new post: the same relation send() writes.
          thread={{ rootId, latestId: () => latestId }}
          onSent={posted}
        />
      </form>
    </Window>
  );
}
