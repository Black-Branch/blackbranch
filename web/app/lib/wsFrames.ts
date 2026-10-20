import type { ChatMsg } from "./chatMsg";

// ─────────────────────────────────────────────────────────────────────────────
// stream-api broadcast socket — the WS frame registry (single source of truth).
//
// Every frame the stream-api WebSocket (site.apiWsOrigin) fans out to
// connected clients is enumerated here as a variant of the `StreamFrame`
// discriminated union. This is the decoupling substrate the modular
// architecture leans on: features talk to each other over these typed frames,
// never by importing one another. Producers live in stream-api (plain JS, so
// this type can't yet constrain them at the call site) — this file is the
// authoritative *contract* the JS side is trusted to honor, and the point where
// the (typed) consumers get compile-time narrowing.
//
// TYPE-ONLY. Nothing here runs on the money/broadcast path. The frames that
// carry money — `alert` and the /chat/event celebration cards that ride the
// `message` frame — are DOCUMENTED here but their producers are unchanged.
//
// PRODUCER = stream-api file:line that calls `broadcast({ type: … })`.
// CONSUMER = who branches on the frame. `web` = the Next.js app (narrows on
//   `data.type`); `overlay` = the OBS browser sources (stream-api/overlay-*.html
//   plus an install's own rig overlays); `brain` =
//   stream-ingest's bot (lib/api.js); `none` = nobody, said out loud.
//   Written as a `+`-joined set with NO spaces, because the `overlay` half of
//   this column is machine-checked by overlayFrames.test.ts, which parses these
//   lines.
// Frames a given consumer doesn't name simply fall through — no consumer runs
// an exhaustive `assertNever`, so the union may be wider than any one switch.
//
// The PRODUCER column below is MODULE:LINE and it goes stale on every edit to
// stream-api — re-derive it by grepping `type: '<frame>'` across
// stream-api/*.js rather than trusting a line number. The frame SET is
// machine-gated by wsFrameContract.test.ts; these locations are NOT.
//
//  FRAME              PRODUCER (stream-api)              CONSUMER     NOTES
//  hello              ws-hub.js (first frame on connect) internal     { internal } — the hub's
//                                                                     verdict on the secret
//  history            ws-hub.js:98 (on connect)          web          replay of msgBuffer
//  message            chat.js:372/620, money.js:441/526, web+overlay  full ChatMsg row.
//                     poll.js:79, alert.js:52                         /chat/event money
//                                                                     cards ride this frame;
//                                                                     overlay-poll.html reads it
//  delete             chat-mod.js:63 / 100               web
//  purge              chat-mod.js:140 / 176              web          bulk delete, one frame
//  pin                chat-mod.js:29                     web          forwarded to PinnedBanner
//  vote               chat-mod.js:18                     web          score correction
//  chat_settings      chat-mod.js:187                    web          slow-mode (window event)
//  showSticker        money.js:295 / 306                 overlay
//  stickerMove        money.js:528                       web          re-sorted ChatMsg row
//  showSupportBubble  lifecycle.js:50                    overlay      support-bubble.html
//  resetSupportBar    supportbar.js:59                   overlay      support-bar.html
//  updateSupportBar   supportbar.js:48                   overlay      (retires with support-bar.html)
//  meterState         meter.js emit()                    overlay      support meter pill
//                                                                     (OBS meter.html is the
//                                                                     only consumer; the site
//                                                                     bar does not read it)
//  showAlert          alert.js:34 (built) / 288 (sent)   overlay      alert-overlay.html;
//                                                                     presentation fields only
//  timerState         timer.js:88 snapshot()             web+overlay  heartbeat: deltaSec 0
//  sponsorState       sponsors.js buildFrame()           web+overlay  Fund the Night credit pool;
//                                                                     overlay = credit.html
//                                                                     (rotating credit line), web =
//                                                                     the chat clock badge
//  badges_changed     chat-mod.js:196                    web          nudge badge refetch
//  announce           chat-mod.js (/chat/announce)       web          a mod's announcement; never
//                                                                     buffered
//  spotlight          chat-mod.js (/chat/spotlight)      web          the streamer's highlighted
//                                                                     message (null = none);
//                                                                     replays on connect
//                                                                     (ws-hub connectFrames)
//  pollUpdate         poll.js:104 / 245                  web+overlay  live tally, in place
//  pollEnd            poll.js:230                        web+overlay  final poll state
//  bot_mode           owner plugin (bot config)          brain
//  bot_active         owner plugin (bot config)          brain      runtime pause/resume
//  bot_tools          owner plugin (bot config)          brain      disabled-tool set
//  config_changed     instance-config.js afterWrite()    web+brain  instance settings written;
//                                                                     KEY NAMES only — every
//                                                                     browser hears it. web's
//                                                                     server + stream-ingest
//                                                                     re-read their caches
//  config_test        instance-config.js test()          brain      run a credential's provider
//                                                                     check in stream-ingest; it
//                                                                     answers on /config/report
//  config_ai_probe    ai.js check() via ask()            brain      the AI page's Detect / Test,
//                                                                     run in stream-ingest; it
//                                                                     answers on /config/report
//  config_content_changed content.js after()            brain      a prompt / the facts / the
//                                                                     behavior file was written;
//                                                                     stream-ingest re-reads /content
// ─────────────────────────────────────────────────────────────────────────────

/** A message id on the wire is a platform string id or a numeric native id. */
type WireId = string | number;

/**
 * The full chat-row frame. Its payload IS a `ChatMsg` (built by stream-api and
 * consumed straight into the buffer), tagged with the `message` discriminant.
 * The /chat/event celebration cards (gift/donation/sub/cheer/sticker — the
 * money path) are `message` frames whose `system` field selects the card.
 */
export type MessageFrame = ChatMsg & { type: "message" };

/**
 * A sticker-boost reorder: the SAME row (same platform+id) re-sent so live
 * clients move it to the bottom and grow it in place. Carries a full ChatMsg.
 */
export type StickerMoveFrame = ChatMsg & { type: "stickerMove" };

/** Every frame stream-api broadcasts, as a discriminated union on `type`. */
export type StreamFrame =
  // ── chat / content (consumer: web) ─────────────────────────────────────────
  | { type: "hello"; internal: boolean }
  | { type: "history"; messages: ChatMsg[] }
  | MessageFrame
  | { type: "delete"; messageId: WireId; platform: string | null }
  | { type: "purge"; ids: { platform: string; id: WireId }[]; batchId: string | null }
  | { type: "pin"; pin: unknown }
  | { type: "vote"; platform: string; messageId: WireId; score: number }
  | { type: "chat_settings"; slowModeSeconds: number }
  // ── sticker / support / alert (consumer: web + overlay) ─────────────────────
  | { type: "showSticker"; emoteUrl: string; emoteName: string; username: string; ts: number }
  | StickerMoveFrame
  | { type: "showSupportBubble" }
  | { type: "resetSupportBar" }
  /**
   * The OBS alert-overlay payload (`alert.js buildShowAlert`). There is no
   * separate money-bearing `alert` frame: nothing branched on one across web,
   * the overlays and the brain. Every field is string-coerced by the builder.
   */
  | {
      type: "showAlert";
      platform: string;
      eventType: string;
      username: string;
      userImage: string;
      amount: string;
      message: string;
      recipient: string;
      label: string;
      tier: string;
      months: string;
    }
  /** Support-bar running total (supportbar.js:47). `total`/`delta` are numbers. */
  | { type: "updateSupportBar"; username: string; total: number; delta: number }
  /**
   * Meter state (meter.js `broadcast()`). Ratio-only frame for the OBS meter overlay
   * (`meter.html`) — no dollar figures on the wire by design. The site meta bar does not
   * render it. Broadcast on every change AND as a periodic heartbeat. All ratios clamped [0,2]
   * server-side; null means unknown (don't render).
   */
  | { type: "meterState"; pace: number | null; tonight: number | null; staleSec: number | null }
  /**
   * Marathon timer state (timer.js `snapshot()`). Broadcast on every change AND
   * as a periodic heartbeat — `deltaSec` is 0 for the heartbeat and non-zero to
   * drive the overlay's +/- popup, so consumers must not treat 0 as "no change".
   */
  | {
      type: "timerState";
      running: boolean;
      remainingSec: number;
      capEnabled: boolean;
      capSec: number;
      usdPerHour: number;
      fillUsd: number;
      baseSec: number;
      deltaSec: number;
      /** The support bar's running $ total, so a viewer loading mid-stream can
       *  render the bar immediately — `updateSupportBar` only fires ON a
       *  contribution, so it alone would leave a fresh page blank until the
       *  next donation. Rides this frame's 15s heartbeat instead.
       *  wsFrameContract.test.ts asserts on frame TYPE NAMES, not fields — the
       *  guard for this one is stream-api's timer.test.js. */
      barTotal: number;
      /** Floor lock: at zero, donations stop buying time. Config, not state. */
      lockAtZero: boolean;
      /** Broadcaster master switch for the whole low-timer treatment. */
      lowPulseEnabled: boolean;
      lowThresholdSec: number;
      lowRampRate: number;
      lowGlowMax: number;
      /** DERIVED server-side: at the cap ceiling OR the zero floor. */
      locked: boolean;
      /**
       * Fund the Night. Additive: every field above is untouched, so a
       * consumer that has never heard of a night keeps rendering exactly what
       * it did. `active: false` is the legacy/marathon world (every other
       * `night.*` field is inert then — 0 or false).
       *
       * `remainingSec` above (and `night.gapSec`, its restatement) MAY BE
       * NEGATIVE while `night.active` is true — the deficit, no floor by
       * design (timer.js: "a negative gap means the night is unfunded ahead of
       * now"). The legacy marathon floor at 0 still holds whenever no night is
       * active. A consumer that renders `remainingSec` as a plain countdown
       * (formatTimer, timerLowState) must floor it itself — see
       * useStreamTimer.ts / timerLowState.ts, which already do.
       */
      night: {
        active: boolean;
        /** The whole night, in streamed seconds. */
        durationSec: number;
        /** How much of the night has been streamed (the "ember"). */
        elapsedSec: number;
        /** Restates `remainingSec` inside the block — same sign, same value. */
        gapSec: number;
        /** Free pre-funded territory at the top of the night. */
        seedSec: number;
        /** How far into the night is funded — `elapsedSec + gapSec`, clamped
         *  to the night's own [seedSec, durationSec] bounds while active.
         *  Approximately, not exactly: the producer rounds all three of these
         *  from three separate `Date.now()` reads, so the identity can be off
         *  by 1. Never re-derive one of the three from the other two. */
        frontierSec: number;
        /** `frontierSec >= durationSec` while active — the fuse overlay's
         *  "NIGHT FUNDED" signal. Always false with no night active. */
        funded: boolean;
        /** The MAGNITUDE of a negative gap (0 when in the black, which with
         *  no night active it always is). */
        deficitSec: number;
        /** When this night began (ms since epoch); null with no night. Read by
         *  stream-api's liveness watchdog to tell an outage from a night the
         *  stream has never been live during. Nothing on the site renders it. */
        startedAtMs: number | null;
      };
    }
  /**
   * Fund the Night: the sponsor credit pool (sponsors.js `buildFrame()`) — who
   * is currently keeping tonight's clock funded, sorted biggest weight first.
   * Two consumers derive DIFFERENT things from the SAME pool: the credit-line
   * overlay (credit.html) rotates through every name; the web chat clock badge
   * (SponsorClockBadge) matches its own row's username against `sponsors` to
   * decide whether to render at all — `clockRemainSec <= 0` means "not
   * currently funding," not "never has."
   */
  | {
      type: "sponsorState";
      sponsors: {
        /** The name chat shows for this person: the linked site account's
         *  display_name when there is one (a Streamlabs "GadgetFan" is
         *  credited as "Gadget Qorm"), else the name the money arrived under. */
        name: string;
        /** Other names this identity was credited under — the platform
         *  donation names when `name` is a site display name. The chat clock
         *  badge matches on these too, so a Twitch-side line from the same
         *  person still lights. Usually empty. Always sent; typed optional so a
         *  reader tolerates an older frame without it. */
        aliases?: string[];
        /** Share of the FULL pool (not just what's rendered) — a capped
         *  frame's percentages can legitimately sum to under 100. */
        weightPct: number;
        /** Seconds of tonight's clock this donor is currently keeping alive.
         *  0 = in the pool (they've given) but not funding the CURRENT
         *  moment — never negative (server-clamped). */
        clockRemainSec: number;
        /** Length of the CURRENT unbroken badge window (stacking extends it,
         *  a mint after expiry restarts it) — `clockRemainSec / clockTotalSec`
         *  is the sweep badge's fill. */
        clockTotalSec: number;
      }[];
    }
  // ── badges ──────────────────────────────────────────────────────────────────
  | { type: "badges_changed" }
  // ── direct messages + announcements ─────────────────────────────────────────
  /** A mod's announcement: plain text, not Matrix, not respondable. `by` is the mod's name. */
  | { type: "announce"; id: string; text: string; by: string; at: number }
  /**
   * The streamer's highlighted message (chatSpotlight.ts): the one row being
   * answered on stream, shown to everyone with the highlight-card look. In
   * memory on stream-api and replayed to every connecting client, so it is also
   * a connect-time frame (after `history`). `null` clears it.
   */
  | { type: "spotlight"; spotlight: { platform: string; messageId: WireId } | null }
  // ── polls (consumer: web) ────────────────────────────────────────────────────
  | { type: "pollUpdate"; poll: NonNullable<ChatMsg["poll"]> }
  | { type: "pollEnd"; poll: NonNullable<ChatMsg["poll"]>; endedBy: string | null }
  // ── Bot control (consumer: brain / stream-ingest) ────────────────────────────
  | { type: "bot_mode"; mode: string }
  | { type: "bot_active"; active: "auto" | "on" | "off" }
  | { type: "bot_tools"; disabled: string[] }
  // ── instance settings (consumer: web server + brain) ──────────────────────────
  /** Instance settings were written (stream-api instance-config.js). Carries key NAMES, never
   *  values: this frame reaches every browser and overlay on the socket. */
  | { type: "config_changed"; keys: string[] }
  /** Ask stream-ingest to run one credential's provider check; it reports the result, with
   *  this nonce, to stream-api's /config/report. Key name + nonce only. */
  | { type: "config_test"; key: string; nonce: string }
  /** Ask stream-ingest to run the AI page's Detect (a connection's models) or Test (a slot's
   *  route); it answers with a fixed code + ids, with this nonce, on /config/report. */
  | { type: "config_ai_probe"; op: "detect" | "test"; id: string; nonce: string }
  /** Instance content was written (stream-api content.js): content key NAMES only, sent to
   *  internal sockets; stream-ingest re-reads GET /content. */
  | { type: "config_content_changed"; keys: string[] };

/** The `type` discriminant of any frame — the set of legal frame names. */
export type StreamFrameType = StreamFrame["type"];

// Exhaustiveness lock. `Record<StreamFrameType, true>` requires EVERY frame type
// as a key exactly once: add a variant to `StreamFrame` without registering it
// here and TypeScript errors (missing key); leave a stale key behind and it
// errors too (excess key). So the wire vocabulary and this registry can't drift
// apart silently — the whole reason the frame bus is a real, checkable layer and
// not a scatter of magic strings across three codebases.
const REGISTERED: Record<StreamFrameType, true> = {
  hello: true,
  history: true,
  message: true,
  delete: true,
  purge: true,
  pin: true,
  vote: true,
  chat_settings: true,
  showSticker: true,
  stickerMove: true,
  showSupportBubble: true,
  resetSupportBar: true,
  showAlert: true,
  updateSupportBar: true,
  meterState: true,
  timerState: true,
  sponsorState: true,
  badges_changed: true,
  announce: true,
  spotlight: true,
  pollUpdate: true,
  pollEnd: true,
  bot_mode: true,
  bot_active: true,
  bot_tools: true,
  config_changed: true,
  config_test: true,
  config_ai_probe: true,
  config_content_changed: true,
};

/** Runtime list of every legal frame name (derived from the exhaustiveness lock). */
// @test-only wsFrameContract.test.ts diffs the registry against stream-api broadcast() calls.
export const STREAM_FRAME_TYPES = Object.keys(REGISTERED) as StreamFrameType[];
