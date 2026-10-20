import { EventStatus } from "matrix-js-sdk";
import type { Room, MatrixEvent, MatrixClient } from "matrix-js-sdk";

// Redacting (delete / un-react) requires a server-confirmed event. A still-
// pending local echo carries a temporary id starting with "~"; calling
// redactEvent on it makes the SDK reach for room.getPendingEvents(), which
// throws under our "chronological" pending-event ordering. So for an
// unconfirmed echo we cancel it instead (if cancellable) and never redact a "~"
// id; confirmed events ("$...") redact normally. This is what makes deleting /
// un-reacting your own just-sent message/reaction work within the confirm window.
const CANCELLABLE: EventStatus[] = [
  EventStatus.QUEUED,
  EventStatus.NOT_SENT,
  EventStatus.ENCRYPTING,
];

export function redactOrCancel(client: MatrixClient, room: Room, ev: MatrixEvent) {
  const id = ev.getId();
  if (!id) return;
  if (id.startsWith("~")) {
    // Unconfirmed local echo — there is nothing server-side to redact.
    if (ev.status && CANCELLABLE.includes(ev.status)) {
      try {
        (client as unknown as { cancelPendingEvent: (e: MatrixEvent) => void }).cancelPendingEvent(ev);
      } catch {
        /* mid-flight (SENDING): can't cancel or redact yet — it'll confirm shortly */
      }
    }
    return;
  }
  (client as unknown as { redactEvent: (r: string, e: string) => Promise<unknown> })
    .redactEvent(room.roomId, id)
    .catch((e: unknown) => console.error("[Matrix] redact failed", e));
}
