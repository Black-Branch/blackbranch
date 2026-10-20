import { requireMod } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";

// Mod proxy for the marathon timer — the `/timer …` site commands.
//
// The timer lives on stream-api behind `requireInternal`, which the browser
// cannot satisfy (a peer host is deliberately NOT IP-trusted). This thin proxy adds
// the mod check and forwards with STREAM_API_SECRET.
//
// A WEB route rather than new code in stream-api/index.js, which is a
// composition root; nothing here needs to live server-side.
//
// The same timer is still driven from Twitch chat by stream-ingest's
// !start/!pause/!a/!s handlers. Both paths hit the same endpoints, so they stay
// consistent with each other.

type Action =
  | { action: "start" | "pause" }
  | { action: "set"; input: string }
  | { action: "add" | "sub"; input: string }
  | { action: "cap"; input: string }
  | { action: "hr"; value: number }
  | { action: "fill"; value: number }
  // v81 — the knobs the mod panel added that never had a slash command:
  // set-default, lock-at-zero and the low-timer effects curve. Forwarded as a
  // whole object because stream-api's setConfig already treats every field as
  // optional-means-unchanged; enumerating them here would be a second place to
  // keep in sync for no gain.
  | { action: "config"; config: TimerConfigPatch }
  // Fund the Night. Nested like `config` for the same reason (one object
  // forwarded whole), but the fields ARE enumerated below and the browser
  // speaks HOURS and DOLLARS — the proxy owns the unit translation to
  // stream-api's `seedSec`/`priceCents`. The panel sets the target directly,
  // at start or mid-night, because the meter's required-$/day can be wrong
  // with no time to fix `fin`.
  | { action: "night"; night: NightCommand };

export type NightCommand = {
  action: "start" | "extend" | "end" | "target";
  /** The broadcaster's bedtime, in their own words: "4am" | "4:30am" | "04:30" | "+8h". */
  end?: string;
  /** Encore length, in hours. */
  hours?: number;
  /**
   * The night's target income, whole-night, in DOLLARS. On `start` it
   * overrides the meter-derived price for that night; as `target` it
   * re-prices the RUNNING night — same U curve, new total.
   */
  targetUsd?: number;
  /**
   * Free opening hours (the seed) for `start`. Omitted = stream-api's 2h
   * default — a night deliberately ignores the marathon's default starting
   * time (`baseSec`), which is why the clock "reverts" without this field.
   */
  seedHours?: number;
};

const NIGHT_ACTIONS = new Set(["start", "extend", "end", "target"]);

export type TimerConfigPatch = {
  baseSec?: number;
  lockAtZero?: boolean;
  lowPulseEnabled?: boolean;
  lowThresholdSec?: number;
  lowRampRate?: number;
  lowGlowMax?: number;
};

export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => null)) as Partial<Action> | null;
  const action = String(body?.action ?? "");
  const input = String((body as { input?: string } | null)?.input ?? "").trim();
  const value = Number((body as { value?: number } | null)?.value);

  // Map the site command onto stream-api's shape. `sign` is how it expresses
  // !a vs !s against one adjust endpoint.
  let path: string;
  let payload: Record<string, unknown>;
  switch (action) {
    case "start":
    case "pause":
      path = "/timer/control";
      payload = { action: action === "start" ? "play" : "pause" };
      break;
    case "set":
      if (!input) return bad("Usage: /timer set <time>");
      path = "/timer/set";
      payload = { input };
      break;
    case "add":
    case "sub":
      if (!input) return bad(`Usage: /timer ${action} <time>`);
      path = "/timer/adjust";
      payload = { input, sign: action === "add" ? 1 : -1 };
      break;
    case "cap":
      if (!input) return bad("Usage: /timer cap <duration | off>");
      path = "/timer/config";
      payload = { cap: input };
      break;
    case "hr":
      if (!Number.isFinite(value)) return bad("Usage: /timer hr <minutes>");
      path = "/timer/config";
      payload = { hr: value };
      break;
    case "fill":
      if (!Number.isFinite(value)) return bad("Usage: /timer fill <amount>");
      path = "/timer/config";
      payload = { fill: value };
      break;
    case "config": {
      // Panel-only. stream-api re-validates and clamps every range, so this
      // forwards the patch rather than duplicating the bounds web-side.
      const patch = (body as { config?: TimerConfigPatch } | null)?.config;
      if (!patch || typeof patch !== "object") return bad("config must be an object");
      path = "/timer/config";
      payload = patch;
      break;
    }
    case "night": {
      // Fund the Night's lifecycle: open / encore / close. stream-api owns
      // every rule (the bedtime parse, the price, the encore's blocks) and
      // answers 400 with a sentence when it refuses — see the pass-through
      // below, which is the only way k reads those sentences.
      const night = (body as { night?: Partial<NightCommand> } | null)?.night;
      const nightAction = String(night?.action ?? "");
      if (!NIGHT_ACTIONS.has(nightAction)) {
        return bad("Night action must be start, extend or end");
      }
      path = "/timer/night";
      payload = { action: nightAction };
      if (typeof night?.end === "string" && night.end.trim()) payload.end = night.end.trim();
      if (night?.hours != null) payload.hours = Number(night.hours);
      // Dollars → cents and hours → seconds here, ONCE: stream-api's route
      // reads `priceCents`/`seedSec` and re-validates both (a bad target is
      // its 400, whose sentence passes through below). Presence-validated
      // web-side only so an empty field yields a usage line, not a shrug.
      if (nightAction === "target" || night?.targetUsd != null) {
        const usd = Number(night?.targetUsd);
        if (!Number.isFinite(usd) || usd <= 0) {
          return bad("Target income must be a dollar amount above zero");
        }
        payload.priceCents = Math.round(usd * 100);
      }
      if (night?.seedHours != null) {
        const seedHours = Number(night.seedHours);
        if (!Number.isFinite(seedHours) || seedHours < 0) {
          return bad("Seed must be zero or more hours");
        }
        payload.seedSec = Math.round(seedHours * 3600);
      }
      break;
    }
    default:
      return bad("Unknown timer action");
  }

  const res = await streamApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // A 400 is stream-api telling the CALLER what is wrong with the request
    // — an ambiguous "4" that could be 4am or 4pm, an encore on a night with
    // no priced blocks, a cap with no unit. Passed through with its own status
    // and body so the panel can show the sentence; anything else is a real
    // upstream failure and stays a 502.
    if (res.status === 400) {
      return Response.json({ error: upstreamError(t) }, { status: 400 });
    }
    return new Response(t || "Timer command failed", { status: 502 });
  }
  return Response.json(await res.json().catch(() => ({ ok: true })));
}

/** stream-api answers `{ error }`; unwrap it so the panel shows the sentence
 *  rather than a JSON blob. Falls back to the raw body, then to a generic. */
function upstreamError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
  } catch { /* not JSON — use the text as-is */ }
  return text || "Timer command refused";
}

function bad(msg: string) {
  return new Response(msg, { status: 400 });
}
