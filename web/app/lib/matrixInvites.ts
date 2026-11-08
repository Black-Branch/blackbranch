// Answering a room invite. Matrix has no "decline": leaving an invited room is the refusal, and
// sync then drops it from the invite list. One call for the Community invite row and the DM
// window's request. Type-only on the SDK.
import type { MatrixClient } from "matrix-js-sdk";

export async function declineInvite(client: MatrixClient, roomId: string): Promise<void> {
  await client.leave(roomId);
}
