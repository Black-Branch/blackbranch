"use client";

import type { ChatMsg } from "@/app/lib/chatMsg";
import { useUserLiveMessages } from "@/app/lib/useUserLiveMessages";
import { localpart } from "@/app/lib/matrixDisplay";
import { Window } from "@/app/components/chrome";
import UserCard from "./UserCard";
import ModUndoToast from "./ModUndoToast";

/**
 * The user card as a standalone window (`/popout/user?...`).
 *
 * The popped-out card is rebuilt from identity in the query string rather than
 * from a serialized message, because that is the part that is actually stable:
 * a message id is meaningless in a new document, but matrixId/publicId are
 * exactly what every lookup, mod action and history query keys on.
 *
 * `msg` is therefore a SYNTHETIC ChatMsg. The one consequence worth knowing:
 * per-message actions degrade. "Delete message" needs the id of the message you
 * clicked, so the popout carries it when present, and the card simply has no
 * message to delete when opened without one. Ban/timeout/purge/history are all
 * identity-scoped and work identically here.
 */
export default function UserCardPopout({
  isMod,
  msg,
}: {
  isMod: boolean;
  msg: ChatMsg;
}) {
  const liveMessages = useUserLiveMessages(msg.matrixId, msg.publicId, isMod);

  return (
    <Window
      presentation="page"
      name={localpart(msg.username)}
      title={localpart(msg.username)}
      onClose={() => window.close()}
    >
      <UserCard
        msg={msg}
        isMod={isMod}
        onClose={() => window.close()}
        liveMessages={liveMessages}
        stayOpenAfterAction
      />
      {/* A timeout or ban here offers its Undo here: the window stays open for it. */}
      {isMod && <ModUndoToast />}
    </Window>
  );
}
