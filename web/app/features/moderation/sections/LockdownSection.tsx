"use client";

// The raid panic switch (signups, cross-post, account age, ingest, sub-only, expiry). Internal to
// the `moderation` feature. Levers: Everything · Signups · Cross-posting · Minimum account age ·
// Ingest (per platform / All) · Sub only; the reason line appears only AFTER a lever is thrown,
// plus an expiry.
//
// This is the one control here you reach for while something bad is actively happening, which
// drives every choice below:
//   • current state is the loudest thing in the card — mid-raid the question is "is it ON?"
//   • ONE button locks everything, because a panic button you have to operate twice under
//     pressure is two chances to do half of it
//   • it says plainly what it does NOT do — the fear that stops someone pressing this is "will I
//     lock out the whole community?"
//   • act fast, explain later: pressing a lever applies it at once, THEN the reason line shows
//     — you can explain afterwards, you cannot un-raid afterwards
//   • an expiry, so a lockdown nobody remembers to lift lifts itself

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { siteName } from "@/app/lib/siteName";
import { getJson, postJson } from "@/app/lib/http";
import { INGEST_PLATFORMS, LOCKDOWN_EXPIRY, expiryBody, type ExpiryChoice } from "@/app/lib/lockdownLevers";
import { platformLabel } from "@/app/lib/platforms";
import { card, h2, btn, input, timeAgo, shortName } from "../shared";
import { ageLeverText, type Checkable } from "../lockdownAge";

type Lockdown = {
  signupsDisabled: boolean;
  crosspostDisabled: boolean;
  minAccountAgeDays: number;
  ingestPaused: string[];
  subOnly: boolean;
  expiresAt: string | null;
  untilStreamEnd?: boolean;
  /** A stream is live now — "Until the stream ends" is offered only then. */
  live?: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Homeserver sign-up: a bundle closes it with the signups lever; elsewhere it is managed outside
   *  Black Branch (null = could not be read). */
  homeserver?: { managed: "outside" } | { managed: "bundle"; registration: "open" | "closed"; closedByLockdown: boolean; applied?: boolean } | null;
  /** Per platform, whether an account's age can be checked (stream-api /lockdown/checkable; null =
   *  could not be read). The age lever holds only the checkable ones. */
  checkable?: Checkable | null;
};

/** What the signups lever says about sign-up on the homeserver — a site ban does not reach a
 *  Matrix account made there, so the lever closes that door too where it can. */
function homeserverSignupLine(h: Lockdown["homeserver"], signupsOn: boolean): string {
  if (!h) return "Homeserver sign-up could not be read.";
  if (h.managed === "outside") {
    return "Homeserver sign-up is separate and managed outside Black Branch: close it in your homeserver's sign-in service (with MAS: password registration) — an account made there can still join the community's rooms.";
  }
  // The lockdown's last change has not reached the homeserver (its render failed; it is retried).
  const pending = h.applied === false ? " Not applied to the homeserver yet — retrying." : "";
  if (h.closedByLockdown) return `Homeserver sign-up: closed by this lockdown; it opens again when the lockdown lifts.${pending}`;
  if (h.registration === "closed") return (signupsOn ? "Homeserver sign-up: already closed (Admin Panel → Site)." : "Homeserver sign-up: closed (Admin Panel → Site).") + pending;
  // Lever on and sign-up open: the lockdown closes it once; an admin who opened it again keeps it.
  return (signupsOn ? "Homeserver sign-up: open — set in Admin Panel → Site during this lockdown, and left as set." : "Homeserver sign-up is open: this lever also closes it while on.") + pending;
}

type Levers = {
  signupsDisabled?: boolean;
  crosspostDisabled?: boolean;
  minAccountAgeDays?: number;
  ingestPaused?: string[];
  subOnly?: boolean;
  expiresInMinutes?: number | null;
  untilStreamEnd?: true;
  reason?: string | null;
};

// The default: 7 days catches accounts minted for the raid — the overwhelming majority — while
// still letting in someone who genuinely found the stream last week.
const DEFAULT_MIN_AGE_DAYS = 7;
const ALL_INGEST = [...INGEST_PLATFORMS];

export default function LockdownSection({ note }: { note: (m: string) => void }) {
  const [state, setState] = useState<Lockdown | null>(null);
  const [reason, setReason] = useState("");
  // The reason line shows after a lever was thrown in this visit (act fast, explain later).
  const [askReason, setAskReason] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryChoice>("none");
  const [customAt, setCustomAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const reload = useCallback(async () => {
    setState(await getJson<Lockdown>("/api/mod/lockdown").catch(() => null));
  }, []);
  useEffect(() => {
    getJson<Lockdown>("/api/mod/lockdown").then(setState).catch(() => setState(null));
  }, []);

  async function apply(levers: Levers, msg: string, { thrown = true } = {}) {
    setBusy(true);
    try {
      // A lever thrown with an expiry chosen carries it; lifting everything clears it.
      let body: Levers = { ...levers };
      if (thrown && !("expiresInMinutes" in body) && !body.untilStreamEnd && expiry !== "none") {
        const e = expiryBody(expiry, { customAt, live: state?.live });
        if (!("error" in e)) body = { ...body, ...e };
      }
      const res = await postJson("/api/mod/lockdown", body);
      if (!res.ok) { note("Couldn't change lockdown."); return; }
      await reload();
      setConfirming(false);
      if (thrown) setAskReason(true);
      note(msg);
    } catch {
      note("Couldn't change lockdown.");
    } finally {
      setBusy(false);
    }
  }

  async function saveReason() {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/lockdown", { reason: reason.trim() || null });
      if (!res.ok) { note("Couldn't save the reason."); return; }
      setReason("");
      setAskReason(false);
      await reload();
      note("Reason saved.");
    } finally { setBusy(false); }
  }

  const signups = state?.signupsDisabled === true;
  const crosspost = state?.crosspostDisabled === true;
  const minAge = state?.minAccountAgeDays ?? 0;
  const ageOn = minAge > 0;
  const paused = state?.ingestPaused ?? [];
  const subOnly = state?.subOnly === true;
  const age = ageLeverText(minAge, state?.checkable);
  const anyOn = signups || crosspost || ageOn || paused.length > 0 || subOnly;
  const allOn = signups && crosspost && ageOn;

  const togglePlatform = (p: string) => {
    const next = paused.includes(p) ? paused.filter((x) => x !== p) : [...paused, p];
    void apply({ ingestPaused: next }, paused.includes(p) ? `${platformLabel(p)} chat taken in again.` : `${platformLabel(p)} chat PAUSED.`, { thrown: !paused.includes(p) });
  };

  return (
    <section className={card}>
      <h2 className={h2}>Raid lockdown</h2>

      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${anyOn ? "bg-amber-400" : "bg-emerald-500"}`} />
        <span className={`text-sm font-semibold ${anyOn ? "text-amber-400" : "text-body"}`}>
          {state === null ? "…" : allOn ? "LOCKED DOWN" : anyOn ? "Partially locked" : "Open"}
        </span>
      </div>

      <p className="text-xs text-secondary mb-3">
        Existing members can always sign in and watch. Lockdown stops <em>new accounts</em>,
        <em> outbound posts to other platforms</em>, new platform accounts, a platform&apos;s chat
        coming in, or (sub only) non-subscribers sending on {siteName()}.
      </p>

      {anyOn && state?.updatedAt && (
        <p className="text-xs text-secondary mb-2">
          Since {timeAgo(state.updatedAt)}
          {state.updatedBy ? ` · ${shortName(state.updatedBy)}` : ""}
          {state.reason ? ` · ${state.reason}` : ""}
          {state.untilStreamEnd ? " · lifts when the stream ends"
            : state.expiresAt ? ` · lifts by itself ${new Date(state.expiresAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}` : " · no expiry"}
        </p>
      )}

      {/* The reason line — only AFTER a lever was thrown. */}
      {askReason && anyOn && (
        <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void saveReason(); }}>
          <input className={`${input} w-full`} placeholder="Why? (optional) — e.g. raid from …" value={reason}
            onChange={(e) => setReason(e.target.value)} disabled={busy} aria-label="Lockdown reason" autoFocus />
          <button type="submit" className={btn} disabled={busy || !reason.trim()}>Save reason</button>
        </form>
      )}

      {/* Expiry: applied with the next lever thrown, or now to a lockdown already on
          (15 min · 1 hour · until the stream ends · a custom moment). */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-secondary">
        <span>Lifts by itself</span>
        <select value={expiry} aria-label="Lockdown expiry"
          onChange={(e) => {
            const c = e.target.value as ExpiryChoice;
            setExpiry(c);
            if (!anyOn || c === "custom") return;
            const b = expiryBody(c, { live: state?.live });
            if ("error" in b) { note(b.error); return; }
            void apply(b, "untilStreamEnd" in b ? "Lockdown lifts when the stream ends." : b.expiresInMinutes === null ? "Lockdown has no expiry." : `Lockdown lifts by itself in ${LOCKDOWN_EXPIRY.find((x) => x.key === c)?.label}.`, { thrown: false });
          }}
          className="rounded-lg bg-surface-1 border border-edge px-2 py-1 text-xs text-body">
          {LOCKDOWN_EXPIRY.map((x) => (
            <option key={x.key} value={x.key} disabled={x.key === "stream" && !state?.live}>
              {x.key === "stream" && !state?.live ? `${x.label} (no stream live)` : x.label}
            </option>
          ))}
        </select>
        {expiry === "custom" && (
          <>
            <input type="datetime-local" value={customAt} onChange={(e) => setCustomAt(e.target.value)} aria-label="Lifts at"
              className="rounded-lg bg-surface-1 border border-edge px-2 py-1 text-xs text-body" />
            {anyOn && (
              <button type="button" className={btn} disabled={busy || !customAt} onClick={() => {
                const b = expiryBody("custom", { customAt });
                if ("error" in b) { note(b.error); return; }
                void apply(b, `Lockdown lifts by itself at ${new Date(customAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}.`, { thrown: false });
              }}>Set</button>
            )}
          </>
        )}
      </div>

      {/* Master control. Present first and styled loudest: in the moment that matters you want
          one button, not a decision about which pipe to close. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {anyOn && (
          <button
            className={btn}
            disabled={busy}
            onClick={() => apply(
              { signupsDisabled: false, crosspostDisabled: false, minAccountAgeDays: 0, ingestPaused: [], subOnly: false, expiresInMinutes: null, reason: null },
              "Lockdown lifted — everything re-opened.",
              { thrown: false },
            )}
          >
            Lift lockdown
          </button>
        )}
        {!allOn && (confirming ? (
          <>
            <button
              className={`${btn} border-amber-500/50 text-amber-300`}
              disabled={busy}
              onClick={() => apply(
                { signupsDisabled: true, crosspostDisabled: true, minAccountAgeDays: DEFAULT_MIN_AGE_DAYS },
                `LOCKED DOWN — signups and cross-posting blocked, accounts under ${DEFAULT_MIN_AGE_DAYS}d held.`
              )}
            >
              Confirm — lock everything
            </button>
            <button className={btn} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button
            className={`${btn} border-amber-500/40 text-amber-300`}
            disabled={busy || state === null}
            onClick={() => setConfirming(true)}
          >
            Lock everything
          </button>
        ))}
      </div>

      {/* Individual levers, for the considered case rather than the panic one. */}
      <div className="space-y-1.5 border-t border-edge pt-3">
        <Lever
          label="New signups"
          on={signups}
          busy={busy || state === null}
          detail={<>Blocks creation of new accounts.<span className="block" data-homeserver-signup={state?.homeserver?.managed ?? "unknown"}>{homeserverSignupLine(state?.homeserver, signups)}</span></>}
          onToggle={() => apply(
            { signupsDisabled: !signups },
            !signups ? "New signups are now BLOCKED." : "New signups re-opened.",
            { thrown: !signups },
          )}
        />
        <Lever
          label="Cross-posting"
          on={crosspost}
          busy={busy || state === null}
          // Names the actual risk. Without this the lever reads as a chat nicety rather than "we
          // are a megaphone pointed at four platforms".
          detail={`Blocks sending to Twitch/Kick/Streamplace/YouTube. Messages still post on ${siteName()}.`}
          onToggle={() => apply(
            { crosspostDisabled: !crosspost },
            !crosspost ? "Cross-posting to platforms is now BLOCKED." : "Cross-posting re-enabled.",
            { thrown: !crosspost },
          )}
        />
        <Lever
          label={`Minimum account age${ageOn ? ` — ${minAge}d` : ""}`}
          on={ageOn}
          busy={busy || state === null}
          // Which platforms it holds is stated HERE, at the switch: a platform whose account age
          // cannot be checked (all of Kick; Twitch without the app's keys; YouTube without an API
          // key) is never held, and each one says so.
          detail={
            <>
              {age.detail}
              {age.unknown.map((line) => <span key={line} className="block" data-age-unknown>{line}</span>)}
            </>
          }
          onToggle={() => apply(
            { minAccountAgeDays: ageOn ? 0 : DEFAULT_MIN_AGE_DAYS },
            ageOn ? "Account-age filter off." : age.armed(DEFAULT_MIN_AGE_DAYS),
            { thrown: !ageOn },
          )}
        />
        <Lever
          label="Sub only"
          on={subOnly}
          busy={busy || state === null}
          detail={`Only subscribers, mods and admins can send on ${siteName()}. Platform chat is each platform's own setting.`}
          onToggle={() => apply(
            { subOnly: !subOnly },
            !subOnly ? "Sub-only chat is ON." : "Sub-only chat off.",
            { thrown: !subOnly },
          )}
        />
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 flex-wrap gap-1" role="group" aria-label="Pause a platform's chat">
            {INGEST_PLATFORMS.map((p) => (
              <button key={p} type="button" aria-pressed={paused.includes(p)} disabled={busy || state === null}
                className={`${btn} ${paused.includes(p) ? "border-amber-500/50 text-amber-300" : ""}`}
                onClick={() => togglePlatform(p)}>
                {platformLabel(p)}
              </button>
            ))}
            <button type="button" disabled={busy || state === null}
              className={`${btn} ${paused.length === ALL_INGEST.length ? "border-amber-500/50 text-amber-300" : ""}`}
              onClick={() => {
                const all = paused.length === ALL_INGEST.length;
                void apply({ ingestPaused: all ? [] : ALL_INGEST }, all ? "Every platform's chat taken in again." : "Chat from EVERY platform PAUSED.", { thrown: !all });
              }}>
              All
            </button>
          </div>
          <div className="min-w-0">
            <div className="text-sm text-body leading-tight">Ingest{paused.length ? ` — paused: ${paused.map(platformLabel).join(", ")}` : ""}</div>
            <div className="text-xs text-muted">A paused platform&apos;s chat does not come in at all — not shown, not stored. {siteName()} chat is never paused.</div>
          </div>
        </div>
      </div>

      {ageOn && (
        <p className="text-xs text-amber-400/90 mt-3">
          Held messages appear in the chat review bar. Nothing is deleted — every held message can
          still be allowed through.
        </p>
      )}
    </section>
  );
}

function Lever({ label, detail, on, busy, onToggle }: {
  label: string; detail: ReactNode; on: boolean; busy: boolean; onToggle: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        className={`${btn} shrink-0 min-w-20 ${on ? "border-amber-500/50 text-amber-300" : ""}`}
        disabled={busy}
        onClick={onToggle}
      >
        {on ? "Blocked" : "Open"}
      </button>
      <div className="min-w-0">
        <div className="text-sm text-body leading-tight">{label}</div>
        <div className="text-xs text-muted">{detail}</div>
      </div>
    </div>
  );
}
