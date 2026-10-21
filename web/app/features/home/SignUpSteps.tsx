"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/app/lib/http";
import nextDynamic from "next/dynamic";
import { Window } from "@/app/components/chrome";
import ProfileEditor from "@/app/components/ProfileEditor";
import LinkedAccountsInline from "@/app/components/LinkedAccountsInline";
import PresenceStatusPicker from "@/app/components/PresenceStatusPicker";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { useEncryptionStatus } from "@/app/lib/useEncryptionStatus";
import { useNarrowViewport } from "@/app/lib/useNarrowViewport";
import { bumpAvatarVersion, patchProfileCardMe } from "@/app/lib/profileCardPrefetch";
import { useSignupProgress } from "./useSignupProgress";
import { OwnCard } from "./OwnCard";

// The sign-up steps: after the first sign-in the
// left column walks the person through linking platforms, making the profile
// theirs and securing DMs. Every step embeds the account card's own page body —
// nothing here is a second editor. Steps 4 (looks) and 6 (questions) keep their
// numbers and are skipped over while they have no content.
//
// Step 5 mounts MatrixSettings — the same useMatrixEncryptionSetup machine the
// account card's Devices & Security page runs — through next/dynamic only, so
// the SDK never joins the front page's static import graph, and only when the
// person taps into it (mounting MatrixSettings boots the client). A device whose encryption is
// already set up (the encryption verdict is green — the sign-in pop-up did it) is not asked again:
// step 5 says it is done.
const MatrixSettings = nextDynamic(() => import("@/app/components/MatrixSettings"), { ssr: false });

/** @test-only the step list is used in this file; the test pins it so a new slice adds its step here, not in prose. */
export const SHIPPED_STEPS = [2, 3, 5] as const;
type Shipped = (typeof SHIPPED_STEPS)[number];

/** The steps this install walks: "Link your platforms" only when there is a platform to link — an
 *  install with none would open on the panel's "No platforms configured yet." dead end.
 *  @test-only used by SignedInColumn below; exported so the skip is pinned by its test. */
export function stepsFor(platforms: boolean): readonly Shipped[] {
  return platforms ? SHIPPED_STEPS : SHIPPED_STEPS.filter((s) => s !== 2);
}

/** @test-only used by SignedInColumn below; exported so the skip-over rule (4 → 5, 6 → done) is pinned by its test. */
export function nextShipped(step: number, steps: readonly Shipped[] = SHIPPED_STEPS): Shipped | "done" {
  return steps.find((s) => s > step) ?? "done";
}
/** @test-only used by SignedInColumn below; exported so the Back rule (the first step has none) is pinned by its test. */
export function prevShipped(step: number, steps: readonly Shipped[] = SHIPPED_STEPS): Shipped | null {
  const before = steps.filter((s) => s < step);
  return before.length ? before[before.length - 1]! : null;
}
/** A stored step this install does not walk (4, 6 — or 2 with no platform) shows the next one. */
function shownStep(step: number, steps: readonly Shipped[]): Shipped {
  if ((steps as readonly number[]).includes(step)) return step as Shipped;
  const next = nextShipped(step, steps);
  return next === "done" ? 5 : next;
}

/** Whether this install has a platform to link (configured or waiting on its keys), from the
 *  account panel's own route. undefined = not answered yet; a failed answer keeps the step. */
function usePlatformsToLink(ask: boolean): boolean | undefined {
  const [answer, setAnswer] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!ask) return;
    let cancelled = false;
    getJson<{ configuredPlatforms?: string[] }>("/api/account-links", { cache: "no-store" })
      .then((d) => { if (!cancelled) setAnswer((d.configuredPlatforms?.length ?? 0) > 0); })
      .catch(() => { if (!cancelled) setAnswer(true); });
    return () => { cancelled = true; };
  }, [ask]);
  return answer;
}

const TITLES: Record<Shipped, string> = { 2: "Link your platforms", 3: "Make it yours", 5: "Secure your DMs" };
const BTN = "px-3 py-1.5 rounded-md bg-surface-3 hover:bg-surface-5 text-sm text-strong";

/** @test-only rendered by SignedInColumn below; exported so each step's copy and buttons render under test without the identity context. */
export function StepView({ step, matrixId, encryptionReady = false, steps = SHIPPED_STEPS, onNext, onBack, onSkipAll }: {
  step: Shipped; matrixId: string; onNext: () => void; onBack: () => void; onSkipAll: () => void;
  /** The steps this install walks (stepsFor). */
  steps?: readonly Shipped[];
  /** This device's encryption is already set up (the sign-in pop-up did it): step 5 says so and
   *  asks nothing again. */
  encryptionReady?: boolean;
}) {
  const [security, setSecurity] = useState(false);
  // The host picks the presentation: on a phone the security
  // window is a task PANEL inside the Home pane (its WindowLayerTarget), never
  // a body-level dialog covering the whole screen; desktop's dock pane has no
  // target, so a dialog there — as the forum composer does.
  const narrow = useNarrowViewport();
  const idx = steps.indexOf(step) + 1;
  return (
    <section className="rounded-lg bg-surface-1 p-4 flex flex-col gap-3 min-w-0" data-signup-step={step}>
      <header>
        <p className="text-2xs text-muted">Step {idx} of {steps.length}</p>
        <h2 className="text-base font-semibold text-strong">{TITLES[step]}</h2>
      </header>

      {step === 2 && (
        <>
          <p className="text-xs text-secondary">Your messages from these get your name and colour here.</p>
          <LinkedAccountsInline />
        </>
      )}

      {step === 3 && (
        <>
          {/* onBack fires only when the name is saved unchanged — a no-op here;
              the step's own Next moves on. */}
          <ProfileEditor
            matrixId={matrixId}
            onBack={() => {}}
            onAvatarChanged={() => { bumpAvatarVersion(); window.dispatchEvent(new Event("bb:avatar-changed")); }}
            onBannerChanged={(mxc) => patchProfileCardMe(matrixId, { bannerMxc: mxc })}
          />
          <PresenceStatusPicker />
        </>
      )}

      {step === 5 && encryptionReady && (
        <p className="text-xs text-secondary" data-encryption-ready>
          Encryption is already set up on this device — your DMs are end-to-end encrypted. Nothing to do here.
        </p>
      )}

      {step === 5 && !encryptionReady && (
        <>
          <p className="text-xs text-secondary">DMs are end-to-end encrypted. Public rooms and forums are not.</p>
          <p className="text-xs text-secondary">A recovery key lets you read your DMs on a new device. You see it once — save it somewhere safe. Without it, DMs from before a new device can&apos;t be read.</p>
          <button type="button" onClick={() => setSecurity(true)} className={`self-start font-semibold ${BTN}`}>
            Set up encryption
          </button>
          {security && (
            <Window presentation={narrow ? "panel" : "dialog"} kind="task" name="Security" title="Devices & Security" onClose={() => setSecurity(false)} width={480}>
              <MatrixSettings onEncryptionChange={(s) => window.dispatchEvent(new CustomEvent("bb:encryption-status", { detail: s }))} />
            </Window>
          )}
        </>
      )}

      <footer className="flex items-center gap-2 pt-1">
        {prevShipped(step, steps) !== null && (
          <button type="button" onClick={onBack} className={BTN}>Back</button>
        )}
        <button type="button" onClick={onNext} className={`font-semibold ${BTN}`}>
          {step === 5 ? "Done" : "Next"}
        </button>
        <button type="button" onClick={onSkipAll} className="ml-auto text-2xs text-muted hover:text-strong">Skip setup</button>
      </footer>
    </section>
  );
}

/** The whole signed-in left column: the card, or the step the person is on. */
export function SignedInColumn({ active }: { active: boolean }) {
  const { matrixId } = useMatrixIdentity();
  const { step, setStep } = useSignupProgress(active, !!matrixId);
  // Green = this device is cross-signed: the sign-in pop-up already set encryption up.
  const { verdict } = useEncryptionStatus();
  const walking = step !== undefined && step !== "done";
  const platforms = usePlatformsToLink(active && !!matrixId && walking);
  if (!matrixId) return null;
  // Not asked yet → the card (never a flash of steps over it); done → the card.
  if (step === undefined || step === "done") return <OwnCard onEdit={() => setStep(3)} />;
  // Step 2 waits for the answer: never a flash of "Link your platforms" on an install with none.
  if (platforms === undefined && shownStep(step ?? 2, SHIPPED_STEPS) === 2) return null;
  const steps = stepsFor(platforms !== false);
  const shown = shownStep(step ?? 2, steps);
  return (
    <StepView
      step={shown}
      steps={steps}
      matrixId={matrixId}
      encryptionReady={verdict === "green"}
      onNext={() => setStep(nextShipped(shown, steps))}
      onBack={() => { const p = prevShipped(shown, steps); if (p !== null) setStep(p); }}
      onSkipAll={() => setStep("done")}
    />
  );
}
