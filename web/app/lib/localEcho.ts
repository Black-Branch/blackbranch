import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

// A message's own send state, read off its local echo. The client runs
// `pendingEventOrdering: "chronological"`, so a failed send stays in the live
// timeline as a NOT_SENT echo; a row that ignores `ev.status` shows it exactly
// like a delivered message. One rule for every surface that shows our own
// messages (community timeline, DM window).
//
// Type-only on the SDK, because matrixDm.ts (the lazy terminal's DM reads)
// imports this: the SDK's EventStatus values are written as its own strings
// (pinned against the enum in localEcho.test.ts).

export type EchoState = "sent" | "sending" | "failed";

/** The statuses `cancelPendingEvent` accepts; anything else throws. */
export const CANCELLABLE_STATES: readonly string[] = ["queued", "not_sent", "encrypting"];

export function echoState(ev: MatrixEvent): EchoState {
  const s = ev.status as string | null;
  if (s === "not_sent" || s === "cancelled") return "failed";
  if (s === "queued" || s === "sending" || s === "encrypting") return "sending";
  return "sent";
}

/** Send a failed echo again. A second failure flips it back to not_sent (the
 *  row re-renders "Not sent"), so the rejection is only logged. */
export async function retryEcho(client: MatrixClient, room: Room, ev: MatrixEvent): Promise<void> {
  if ((ev.status as string | null) !== "not_sent") return;
  try {
    await client.resendEvent(ev, room);
  } catch (e) {
    console.error("[Matrix] resend failed", e);
  }
}

/** Remove an unsent echo from the timeline. A SENDING echo cannot be
 *  cancelled; it is left to confirm or fail. */
export function dropEcho(client: MatrixClient, ev: MatrixEvent): void {
  if (!ev.status || !CANCELLABLE_STATES.includes(ev.status)) return;
  try {
    client.cancelPendingEvent(ev);
  } catch {
    /* it moved to SENDING between the check and the call */
  }
}

/** The echo a send with our own `txnId` left in `room`, or null when none was
 *  made. The SDK names a local echo "~" + roomId + ":" + txnId (pinned in
 *  localEcho.test.ts). */
export function localEchoOf(room: Room, txnId: string): MatrixEvent | null {
  return room.findEventById(`~${room.roomId}:${txnId}`) ?? null;
}
