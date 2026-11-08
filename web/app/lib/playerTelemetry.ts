// What the in-house player tells the error sink when it stalls or reconnects.
// Pure — no DOM, no RTCPeerConnection — so the shape is unit-testable; the
// player only gathers the inputs. One row per EVENT, never a periodic sample:
// a player that stalls and recovers silently leaves no trace, and the fix for
// "we can't tell" is a row at each decision.
//
// "One row per event" is a claim about the SINK, not just this file: the
// message returned here embeds `attempt=`/`node=`, and `stack` is
// `JSON.stringify` of the whole input (counters included), not a real stack
// trace. app/lib/errorFingerprint.ts's `source === "player"` branch hashes
// that message+stack VERBATIM rather than normalizing them the way every
// other source is — normalizing would strip the digits this file relies on
// to keep distinct events distinct, and every player row of one reason+state
// would collapse onto a single fingerprint.
// No "ended": since 2026-10-31 a track the node ends is a reconnect
// ("track-ended"), and the site's liveness says when the stream is over.
// "busy" = a 429 from the relay: the player waits Retry-After and tries again.
export type PlayerEventKind = "reconnect" | "failed" | "busy";

/** How far the attempt had got (whepEscalation.ts NegotiationPhase): "signal"
 *  = the offer was out and our own site had not answered, "connect" = answered
 *  but the media path never came up, "media" = it was playing. With the relay's
 *  journal lines ("[whep] slow answer" / "viewer gave up") this is what tells
 *  the node from the viewer's network without guessing. */
type Phase = "ice" | "signal" | "connect" | "media";

type InboundVideoCounters = {
  freezeCount: number | null;
  totalFreezesDuration: number | null;
  totalPausesDuration: number | null;
  packetsLost: number | null;
  nackCount: number | null;
  pliCount: number | null;
  jitter: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
};

const COUNTER_KEYS: ReadonlyArray<keyof InboundVideoCounters> = [
  "freezeCount", "totalFreezesDuration", "totalPausesDuration", "packetsLost",
  "nackCount", "pliCount", "jitter", "framesDecoded", "framesDropped",
];

/** The browser's own video receive counters. A field the browser does not
 *  expose reads back as null — a 0 there would claim "no freezes" on Firefox,
 *  which simply does not count them. */
export function readInboundVideoCounters(reports: Iterable<unknown>): InboundVideoCounters {
  const out = Object.fromEntries(COUNTER_KEYS.map((k) => [k, null])) as InboundVideoCounters;
  for (const r of reports) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (rec.type !== "inbound-rtp" || rec.kind !== "video") continue;
    for (const k of COUNTER_KEYS) {
      const v = rec[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    break;
  }
  return out;
}

export function buildPlayerEvent(input: {
  kind: PlayerEventKind;
  reason: string;
  connectionState: string;
  iceConnectionState: string;
  attempt: number;
  node: string | null;
  mode: "webrtc" | "hls";
  phase: Phase;
  /** ms since this attempt started — in the payload only, so it does not
   *  split one decision's message into a new row per millisecond. */
  elapsedMs: number;
  counters: InboundVideoCounters | null;
}): { message: string; stack: string } {
  const message =
    `player ${input.kind}: ${input.reason} — pc=${input.connectionState}/${input.iceConnectionState}` +
    ` phase=${input.phase} attempt=${input.attempt} node=${input.node ?? "?"}`;
  return { message, stack: JSON.stringify(input) };
}
