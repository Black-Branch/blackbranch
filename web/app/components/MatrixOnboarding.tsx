"use client";

import { useState } from "react";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { useClientValue } from "@/app/lib/useClientState";
import { siteName } from "@/app/lib/siteName";

const STEPS = [
  {
    title: "What is Matrix?",
    body: `Matrix is an open, decentralized messaging protocol — like email, but for chat. Your ${siteName()} account lives on our server but can connect with anyone on any other Matrix server. You own your messages.`,
  },
  {
    title: "What's encrypted?",
    body: "Direct messages and private rooms are end-to-end encrypted — only you and the recipient can read them. Public community rooms are not encrypted, which keeps them fast and browsable by anyone.",
  },
  {
    title: "Your recovery key",
    body: "The recovery key is a long code that protects your encrypted message history. Save it in a password manager. Without it, you can't read old encrypted messages on a new device.",
  },
  {
    title: "Verifying devices",
    body: "When you sign in on a new browser, it starts unverified. Verifying it proves both devices belong to you — after that, encrypted messages flow freely between them. Use the Verify button on any device row below.",
  },
];

const DISMISSED_KEY = "mx_onboarding_dismissed";
const STEP_KEY = "mx_onboarding_step";

export default function MatrixOnboarding() {
  // Hidden during SSR (null fallback = dismissed), then driven by localStorage —
  // no flash and no mount-effect setState. Session actions override below.
  const lsDismissed = useClientValue(() => (lsGet(DISMISSED_KEY) ? "1" : ""), null);
  const savedStep = useClientValue(() => lsGet(STEP_KEY), null);
  const [dismissedNow, setDismissedNow] = useState(false);
  const [stepOverride, setStepOverride] = useState<number | null>(null);

  const dismissed = dismissedNow || lsDismissed !== "";
  const parsedStep = parseInt(savedStep ?? "0", 10);
  const step = stepOverride ?? (isNaN(parsedStep) ? 0 : Math.min(parsedStep, STEPS.length - 1));

  if (dismissed) return null;

  function advance() {
    if (step < STEPS.length - 1) {
      const next = step + 1;
      setStepOverride(next);
      lsSet(STEP_KEY, String(next));
    } else {
      dismiss();
    }
  }

  function dismiss() {
    lsSet(DISMISSED_KEY, "1");
    setDismissedNow(true);
  }

  const current = STEPS[step];
  if (!current) return null;
  const isLast = step === STEPS.length - 1;

  return (
    <div className="mx-3 mt-2.5 mb-0.5 rounded-xl border border-edge bg-surface-1 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-body">{current.title}</p>
        <button
          onClick={dismiss}
          className="text-3xs text-muted hover:text-secondary transition-colors shrink-0 mt-px"
        >
          Dismiss
        </button>
      </div>
      <p className="text-2xs text-secondary leading-relaxed">{current.body}</p>
      <div className="flex items-center justify-between pt-0.5">
        <div className="flex gap-1">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-all ${
                i === step ? "w-4 bg-control-strong" : "w-1.5 bg-control"
              }`}
            />
          ))}
        </div>
        <button
          onClick={advance}
          className="text-xs px-3 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-edge text-body transition-colors"
        >
          {isLast ? "Got it" : "Next"}
        </button>
      </div>
    </div>
  );
}
