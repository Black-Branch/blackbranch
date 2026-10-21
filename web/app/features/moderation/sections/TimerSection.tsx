"use client";

// Timer controls — the panel form of `/timer start|pause|add|sub|cap`, plus the
// set-default control that has no command, and the ONLY way to open, extend or
// end a Fund-the-Night night: stream-api's /timer/night sits behind
// requireInternal, which no browser can satisfy, so without these buttons the
// feature has no caller at all.
//
// Values are LIVE off the timerState WS frame (useStreamTimer), so the panel
// tracks donations and scene-driven pauses without polling. This component owns
// only the writes.
//
// There is no "Lock at zero" control: a night ignores `lockAtZero` server-side
// (during a night the floor lock would refuse exactly the donations a deficit
// needs), and a legacy marathon (no night active) still honors the stored
// column, which nothing here needs to set. The field itself is untouched
// server-side and in `/api/mod/timer`'s config passthrough.

import { useState } from "react";
import { HttpError, postJson, postJsonOrThrow } from "@/app/lib/http";
import { useStreamTimer } from "@/app/lib/useStreamTimer";
import { formatTimer } from "@/app/lib/timerLowState";
import { card, h2, input, btn } from "../shared";

/** "1h30m" | "90m" | "45s" | "90" (bare = seconds) — sent verbatim, stream-api parses. */
const DURATION_HINT = "1h30m";

/** Mirror of stream-api's parseDuration, for the one field that takes seconds
 *  rather than a duration string (`baseSec`). Keep the two in agreement. */
function toSeconds(raw: string): number {
  const str = raw.trim().toLowerCase();
  if (!str) return 0;
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const unit = (re: RegExp, mult: number) => {
    const hit = re.exec(str);
    return hit?.[1] ? Number(hit[1]) * mult : 0;
  };
  return unit(/(\d+)h/, 3600) + unit(/(\d+)m/, 60) + unit(/(\d+)s/, 1);
}

export default function TimerSection({ note }: { note: (m: string) => void }) {
  const timer = useStreamTimer();
  const [amount, setAmount] = useState("");
  const [baseInput, setBaseInput] = useState("");
  const [capInput, setCapInput] = useState("");
  const [nightEnd, setNightEnd] = useState("");
  const [nightHours, setNightHours] = useState("");
  const [nightSeed, setNightSeed] = useState("");
  const [nightTarget, setNightTarget] = useState("");
  const [busy, setBusy] = useState(false);

  // Goes through the SAME /api/mod/timer proxy the `/timer …` slash commands
  // use, so the panel and the commands can never drift apart. `/api/mod/bar`
  // owns reset, because it zeroes the bar as well as the timer.
  // `postJson` returns the RESPONSE, not parsed JSON — read `seconds` from the
  // parsed body, or the refusal branch never fires and every refused adjust
  // toasts success.
  async function call(path: string, body: unknown, ok: string, isAdjust = false) {
    setBusy(true);
    try {
      const res = await postJson(path, body);
      if (!res.ok) {
        // stream-api refuses with a 400 and a sentence — a night is running,
        // a cap with no unit — and both proxies pass it through as { error }.
        note(await refusalText(res));
        return;
      }
      const d = (await res.json().catch(() => null)) as { seconds?: number; reason?: string } | null;
      // A refused adjust is a 200 with seconds: 0, not an error. stream-api
      // says why in `reason` (money.js /timer/adjust); the fallback is only
      // for a producer older than that field.
      note(isAdjust && d?.seconds === 0
        ? (d.reason || "No change — the timer refused that adjustment.")
        : ok);
    } catch {
      note("That didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  /** The sentence in a refused response: `{ error }` from the proxies, or the
   *  raw text; generic when there is neither. */
  async function refusalText(res: Response): Promise<string> {
    const t = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(t) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
    } catch { /* not JSON */ }
    return t && t.length < 200 ? t : "That didn't go through.";
  }

  // Fund the Night's lifecycle (stream-api /timer/night, via the same proxy).
  // Separate from `call` for one reason: stream-api REFUSES a night it cannot
  // read — an ambiguous "4" that is either 4am or 4pm, an encore on a night
  // with no priced blocks — with a 400 and a sentence saying which. Surfacing
  // that sentence is the same courtesy the cap refusal below already extends;
  // "That didn't go through." would leave k retyping a bedtime blind.
  async function callNight(
    night: {
      action: "start" | "extend" | "end" | "target";
      end?: string; hours?: number; targetUsd?: number; seedHours?: number;
    },
    ok: string,
  ) {
    setBusy(true);
    try {
      await postJsonOrThrow("/api/mod/timer", { action: "night", night });
      note(ok);
    } catch (e) {
      note(e instanceof HttpError ? e.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2}>Timer</h2>

      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono tabular-nums text-base text-body">
          {formatTimer(timer.remainingSec)}
        </span>
        <span className="text-xs text-secondary">
          {!timer.known ? "connecting…" : timer.running ? "running" : "paused"}
          {timer.locked && " · locked"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <button type="button" className={btn} disabled={busy}
          onClick={() => call("/api/mod/timer", { action: "start" }, "Timer started.")}>
          Start
        </button>
        <button type="button" className={btn} disabled={busy}
          onClick={() => call("/api/mod/timer", { action: "pause" }, "Timer paused.")}>
          Pause
        </button>
        <button type="button" className={btn} disabled={busy}
          onClick={() => call("/api/mod/bar", { action: "reset" }, "Bar and timer reset.")}>
          Reset
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center mb-3">
        <input className={input} value={amount} placeholder={DURATION_HINT}
          onChange={(e) => setAmount(e.target.value)} aria-label="Time to add or subtract" />
        <button type="button" className={btn} disabled={busy || !amount}
          onClick={() => call("/api/mod/timer", { action: "add", input: amount }, `Added ${amount}.`, true)}>
          Add
        </button>
        <button type="button" className={btn} disabled={busy || !amount}
          onClick={() => call("/api/mod/timer", { action: "sub", input: amount }, `Subtracted ${amount}.`, true)}>
          Sub
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center mb-2">
        <span className="text-sm text-secondary w-24 shrink-0">Set default</span>
        <input className={input} value={baseInput} placeholder={DURATION_HINT}
          onChange={(e) => setBaseInput(e.target.value)} aria-label="Default the timer resets to" />
        <button type="button" className={btn} disabled={busy || !baseInput}
          onClick={() => call("/api/mod/timer", { action: "config", config: { baseSec: toSeconds(baseInput) } },
            "Default updated.")}>
          Save
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-sm text-secondary w-24 shrink-0">Cap</span>
        <input className={input} value={capInput} placeholder="8h — or 'off'"
          onChange={(e) => setCapInput(e.target.value)} aria-label="Maximum the timer may reach" />
        <button type="button" className={btn} disabled={busy || !capInput}
          // A bare number is refused BEFORE the call (stream-api also 400s
          // it): parseDuration reads "10" as 10 SECONDS, so a cap meant as 10
          // hours would become a 10-second ceiling that clamps every donation's
          // added time down to nothing for the whole stream.
          onClick={() => {
            if (/^\d+$/.test(capInput.trim())) {
              note("Cap needs a unit — e.g. 10h or 90m — or 'off'.");
              return;
            }
            void call("/api/mod/timer", { action: "cap", input: capInput }, "Cap updated.");
          }}>
          Save
        </button>
      </div>

      {/* Fund the Night. The night is opened as an END TIME in the
          broadcaster's own words ("11pm") and converted to a streamed duration
          once, at start — so this is a free-text field, not a duration picker:
          stream-api owns the parse and says what it could not read. Seed = the
          free hours the clock OPENS with (a night ignores the marathon's
          default starting time; blank = the 2h default). Target = the night's
          whole income goal in dollars: at start it overrides the meter's
          required-$/day for that night, and "Set target" re-prices the RUNNING
          night — same curve, new total — for when the meter's number is wrong
          and a big donation would otherwise add insultingly little time. */}
      <div className="flex flex-wrap gap-2 items-center mt-3">
        <span className="text-sm text-secondary w-24 shrink-0">Night</span>
        <input className={input} value={nightEnd} placeholder="end time, e.g. 11pm"
          onChange={(e) => setNightEnd(e.target.value)} aria-label="Time the night ends" />
        <input className={input} value={nightSeed} type="number" min="0" step="0.5" placeholder="free hours (2)"
          onChange={(e) => setNightSeed(e.target.value)} aria-label="Free opening hours (seed)" />
        <button type="button" className={btn} disabled={busy || !nightEnd}
          onClick={() => callNight({
            action: "start", end: nightEnd,
            seedHours: nightSeed === "" ? undefined : Number(nightSeed),
            targetUsd: nightTarget === "" ? undefined : Number(nightTarget),
          }, "Night started.")}>
          Start night
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center mt-2">
        <span className="text-sm text-secondary w-24 shrink-0">Target $</span>
        <input className={input} value={nightTarget} type="number" min="1" step="1" placeholder="income goal"
          onChange={(e) => setNightTarget(e.target.value)} aria-label="Night target income in dollars" />
        <button type="button" className={btn} disabled={busy || !nightTarget}
          onClick={() => callNight({ action: "target", targetUsd: Number(nightTarget) },
            `Target set — night repriced to $${nightTarget}.`)}>
          Set target
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center mt-2">
        <span className="text-sm text-secondary w-24 shrink-0">Extend by</span>
        <input className={input} value={nightHours} type="number" min="0.25" step="0.5" placeholder="hours"
          onChange={(e) => setNightHours(e.target.value)} aria-label="Hours to extend the night by" />
        <button type="button" className={btn} disabled={busy || !nightHours}
          onClick={() => callNight({ action: "extend", hours: Number(nightHours) }, `Night extended by ${nightHours}h.`)}>
          Extend
        </button>
        <button type="button" className={btn} disabled={busy}
          onClick={() => callNight({ action: "end" }, "Night ended.")}>
          End night
        </button>
      </div>
    </section>
  );
}
