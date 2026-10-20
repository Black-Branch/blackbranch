// The viewer's remembered transport for the in-house player.
//
// WRITTEN ONLY BY A DELIBERATE CLICK. This is the NO AUTOMATIC DEMOTION rule
// (see StreamplaceThinPlayer.tsx) applied to a persisted key rather than around
// it. The damage an automatic fallback ladder does is not that it switches
// transport — it is that it writes a PERSISTED preference on a transient error,
// so one blip strands a viewer for every future session. Exactly two call sites
// write here, both of them a button the viewer pressed: switchToHls and
// retryLowLatency. No failure path, no watchdog, no escalation.
//
// Not a settingsRegistry entry: this is player-local state set from the control
// bar, like player_volume and player_live_source, neither of which is in the
// registry. No prepaint mirror, so check-prepaint.mjs is unaffected.

export type Transport = "webrtc" | "hls";

export const TRANSPORT_KEY = "player_transport";

const TRANSPORTS: readonly Transport[] = ["webrtc", "hls"];

/** Validate a stored value. Null means absent or junk — the caller defaults. */
export function parseTransport(stored: string | null): Transport | null {
  return (TRANSPORTS as readonly string[]).includes(stored ?? "") ? (stored as Transport) : null;
}
