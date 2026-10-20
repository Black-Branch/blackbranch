"use client";

import { useState } from "react";
import nextDynamic from "next/dynamic";
import { Window } from "@/app/components/chrome";
import ProfileEditor from "@/app/components/ProfileEditor";
import LinkedAccountsInline from "@/app/components/LinkedAccountsInline";
import PresenceStatusPicker from "@/app/components/PresenceStatusPicker";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
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
// person taps into it (mounting MatrixSettings boots the client).
const MatrixSettings = nextDynamic(() => import("@/app/components/MatrixSettings"), { ssr: false });

/** @test-only the step list is used in this file; the test pins it so a new slice adds its step here, not in prose. */
export const SHIPPED_STEPS = [2, 3, 5] as const;
type Shipped = (typeof SHIPPED_STEPS)[number];

/** @test-only used by SignedInColumn below; exported so the skip-over rule (4 → 5, 6 → done) is pinned by its test. */
export function nextShipped(step: number): Shipped | "done" {
  return SHIPPED_STEPS.find((s) => s > step) ?? "done";
}
/** @test-only used by SignedInColumn below; exported so the Back rule (2 has none) is pinned by its test. */
export function prevShipped(step: number): Shipped | null {
  const before = SHIPPED_STEPS.filter((s) => s < step);
  return before.length ? before[before.length - 1]! : null;
}
/** A stored step that is not shipped (4, 6) shows the next shipped one. */
function shownStep(step: number): Shipped {
  if ((SHIPPED_STEPS as readonly number[]).includes(step)) return step as Shipped;
  const next = nextShipped(step);
  return next === "done" ? 5 : next;
}

const TITLES: Record<Shipped, string> = { 2: "Link your platforms", 3: "Make it yours", 5: "Secure your DMs" };
const BTN = "px-3 py-1.5 rounded-md bg-surface-3 hover:bg-surface-5 text-sm text-strong";

/** @test-only rendered by SignedInColumn below; exported so each step's copy and buttons render under test without the identity context. */
export function StepView({ step, matrixId, onNext, onBack, onSkipAll }: {
  step: Shipped; matrixId: string; onNext: () => void; onBack: () => void; onSkipAll: () => void;
}) {
  const [security, setSecurity] = useState(false);
  // The host picks the presentation: on a phone the security
  // window is a task PANEL inside the Home pane (its WindowLayerTarget), never
  // a body-level dialog covering the whole screen; desktop's dock pane has no
  // target, so a dialog there — as the forum composer does.
  const narrow = useNarrowViewport();
  const idx = SHIPPED_STEPS.indexOf(step) + 1;
  return (
    <section className="rounded-lg bg-surface-1 p-4 flex flex-col gap-3 min-w-0" data-signup-step={step}>
      <header>
        <p className="text-2xs text-muted">Step {idx} of {SHIPPED_STEPS.length}</p>
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

      {step === 5 && (
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
        {prevShipped(step) !== null && (
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
  if (!matrixId) return null;
  // Not asked yet → the card (never a flash of steps over it); done → the card.
  if (step === undefined || step === "done") return <OwnCard onEdit={() => setStep(3)} />;
  const shown = shownStep(step ?? 2);
  return (
    <StepView
      step={shown}
      matrixId={matrixId}
      onNext={() => setStep(nextShipped(shown))}
      onBack={() => { const p = prevShipped(shown); if (p !== null) setStep(p); }}
      onSkipAll={() => setStep("done")}
    />
  );
}
