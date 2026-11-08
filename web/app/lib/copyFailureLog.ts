// The owner's record of platform copies that did not land (server only — the
// send route). Viewers are told only what they can act on (sendDelivery.ts
// `deliveryFailureKind`); everything, infrastructure included, is written here.
//
// One info line per failure: platform, class, error, the provider's code
// (`youtube.quota`), Twitch's drop code when Twitch dropped the message
// (`drop=msg_rejected`), and the site line's id for correlation. Never the
// message text and never the sender — and a transient refusal's reason is left
// out, because a platform's own sentence can name people. The drop code is the
// cause in Twitch's own identifiers and never names anyone: without it one
// viewer's every Twitch copy was lost with no cause in the log (2026-10-22).
//
// Rate-limited per platform+class+code(+drop code): a quota-out night is one
// line per 10 minutes, and the next line carries how many it held back
// (`suppressed=N`).
//
// `.ts` extensions: exercised under `node --test`.
import { deliveryFailureKind } from "./sendDelivery.ts";

/**
 * How long identical failures stay quiet after one was logged.
 * @test-only exported so the rate-limit test steps past THIS number, not a copy of it.
 */
export const COPY_LOG_WINDOW_MS = 10 * 60_000;

/** `dropCode` comes from sendDelivery.ts `twitchDropCode`: a documented Twitch code, or "unknown". */
type CopyFailure = { error: string; reason?: string; code?: string; dropCode?: string };

/**
 * A logger over its own sink and clock — the route uses `logCopyFailure` below.
 * @test-only exported so the tests drive the rate limit with their own clock and read the lines.
 */
export function copyFailureLogger(sink: (line: string) => void, clock: () => number) {
  const windows = new Map<string, { at: number; suppressed: number }>();
  return (platform: string, f: CopyFailure, siteMsgId?: number): void => {
    const cls = deliveryFailureKind({ platform, error: f.error, ...(f.reason ? { reason: f.reason } : {}) });
    const code = f.code ?? f.error;
    const key = `${platform}|${cls}|${code}|${f.dropCode ?? ""}`;
    const now = clock();
    const prev = windows.get(key);
    if (prev && now - prev.at < COPY_LOG_WINDOW_MS) { prev.suppressed++; return; }
    windows.set(key, { at: now, suppressed: 0 });
    const parts = [`[chat/send] copy not delivered platform=${platform} class=${cls} error=${f.error}`];
    if (f.reason && cls !== "transient") parts.push(`reason=${/\s/.test(f.reason) ? JSON.stringify(f.reason) : f.reason}`);
    if (f.dropCode) parts.push(`drop=${f.dropCode}`);
    parts.push(`code=${code}`);
    if (siteMsgId != null && Number.isInteger(siteMsgId)) parts.push(`msg=${siteMsgId}`);
    if (prev?.suppressed) parts.push(`suppressed=${prev.suppressed}`);
    sink(parts.join(" "));
  };
}

export const logCopyFailure = copyFailureLogger((line) => console.info(line), Date.now);
