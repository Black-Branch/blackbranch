// What a FAILED send does with the line it took out of the composer.
//
// The composer clears optimistically, and the failure arrives up to the send
// timeout later — by then the sender may have typed the next message, or started
// a reply to someone else. Putting the failed text back over that draft destroys
// it. So: restore only into a composer that is still exactly as the send left it
// (empty, no reply armed); otherwise keep what they are writing and offer the
// failed line as a retry instead.

/** The composer as it is NOW, when the failure lands. */
export type ComposerNow = { draft: string; replyArmed: boolean };

export function failedSendAction(now: ComposerNow): "restore" | "offer-retry" {
  return now.draft.trim() === "" && !now.replyArmed ? "restore" : "offer-retry";
}
