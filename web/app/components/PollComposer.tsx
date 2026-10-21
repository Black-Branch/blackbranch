"use client";

import { useState } from "react";
import { siteName } from "@/app/lib/siteName";
import { postJsonOrThrow, HttpError } from "@/app/lib/http";
import { Window } from "@/app/components/chrome";

// "Start a poll" modal, opened from the composer's poll button. Subscribers
// and mods/admins can start one (server-enforced — a 403 here just explains).
// The poll itself renders as an interactive chat card for everyone; platform
// chatters vote by typing the option number.

const DURATIONS = [
  { sec: 60, label: "1 min" },
  { sec: 120, label: "2 min" },
  { sec: 300, label: "5 min" },
  { sec: 600, label: "10 min" },
  { sec: 1800, label: "30 min" },
];

export default function PollComposer({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [durationSec, setDurationSec] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canStart = question.trim().length > 0 && filled.length >= 2 && !busy;

  function setOption(i: number, v: string) {
    setOptions((prev) => prev.map((o, j) => (j === i ? v : o)));
  }

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await postJsonOrThrow("/api/poll/start", {
        question: question.trim(),
        options: filled,
        durationSec,
      });
      onClose();
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) {
        setError("Polls are a Supporter perk — subscribe to start one!");
      } else if (e instanceof HttpError && e.status === 409) {
        setError("A poll is already running — wait for it to finish.");
      } else {
        setError("Couldn't start the poll — try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full rounded bg-raised border border-control px-2 py-1.5 text-sm text-heading placeholder-muted focus:outline-none focus:border-control-strong";
  return (
    <Window presentation="dialog" name="Start a poll" title="Start a poll" onClose={onClose} width={384}>
      <div className="p-4 flex flex-col">
        <input
          className={field}
          placeholder="Question"
          maxLength={200}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
        />

        <div className="mt-2 space-y-1.5">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-5 text-center text-xs font-bold text-muted shrink-0">{i + 1}</span>
              <input
                className={field}
                placeholder={`Option ${i + 1}`}
                maxLength={100}
                value={o}
                onChange={(e) => setOption(i, e.target.value)}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                  className="text-muted hover:text-red-300 text-xs px-1 shrink-0"
                  aria-label={`Remove option ${i + 1}`}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        {options.length < 6 && (
          <button
            type="button"
            onClick={() => setOptions((prev) => [...prev, ""])}
            className="mt-1.5 text-xs text-secondary hover:text-body transition-colors"
          >
            + Add option
          </button>
        )}

        <div className="mt-3 flex items-center gap-1.5">
          <span className="text-xs text-secondary shrink-0">Duration</span>
          <div className="flex gap-1 flex-wrap">
            {DURATIONS.map((d) => (
              <button
                key={d.sec}
                type="button"
                onClick={() => setDurationSec(d.sec)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  durationSec === d.sec ? "bg-surface-4 text-strong" : "bg-surface-1 text-secondary hover:text-body"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-amber-300/90">{error}</p>}

        <button
          type="button"
          disabled={!canStart}
          onClick={start}
          className="mt-3 w-full rounded-lg py-1.5 text-sm font-semibold text-on-accent disabled:opacity-30 hover:brightness-110 transition-[filter]"
          style={{ backgroundColor: "var(--chat-send-color, var(--accent))" }}
        >
          {busy ? "Starting…" : "Start poll"}
        </button>
        <p className="mt-2 text-2xs text-muted leading-snug">
          Everyone can vote — on {siteName()} by tapping, on Twitch/YouTube/Kick by typing the option number in chat.
        </p>
      </div>
    </Window>
  );
}
