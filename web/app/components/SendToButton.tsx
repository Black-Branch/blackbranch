"use client";

import { useRef, useState } from "react";
import { Chats, Broadcast, Lock, Check } from "@phosphor-icons/react/dist/ssr";
import { siteName } from "@/app/lib/siteName";
import { platformLabel } from "@/app/lib/platforms";
import { refusalState } from "@/app/lib/crossPostCopy";
import { ENCRYPTED_DEST } from "@/app/lib/sendDestination";
import { ctlBox, ctlClass } from "@/app/lib/composerControls";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import PlatformIcon, { PLATFORM_COLORS } from "./PlatformIcon";
import { ComposerPopover } from "./ComposerPopover";
import { keepFocus } from "@/app/lib/keepFocus";
import { useBotName } from "@/app/lib/useBotName";
import type { BindingFace } from "@/app/lib/composerBinding";

type SendToButtonProps = {
  /** The destinations offered, in order: null (this site) → each linked platform → "all". */
  destCycle: (string | null)[];
  forcedDest: string | null;
  /** A destination picked by name from the menu — the only way it changes by hand. */
  onPick: (d: string | null) => void;
  /** While 🔒 is on, the button puts back what it displaced instead of opening the menu. */
  onDisarm: () => void;
  /** Any menu pick — INCLUDING the entry already selected: try that destination
   *  again if a refusal had it skipped this session (platformRefusals.ts). */
  onRetry?: (d: string | null) => void;
  /** platform → why it is skipped this session ("followers-only"), shown beside its name. */
  refusals?: ReadonlyMap<string, string>;
  /** A window holding the composer: the control wears the binding's face, and
   *  a click RELEASES it — the window dismisses and the destination falls back
   *  to `forcedDest`, untouched underneath. `null` when no window binds the
   *  composer (the DM window is one that does). */
  binding?: { face: BindingFace; release: () => void } | null;
};

/**
 * Where this message goes — the site, one linked platform, or all of them.
 *
 * It is the one composer control whose CURRENT VALUE changes what pressing
 * Enter does, so it lives on the bar where you can see it without opening
 * anything. It sits between the pfp/settings button and the field.
 *
 * A click opens a small MENU naming every destination; picking one is the
 * choice. It never cycles: stepping through values made every intermediate
 * value a "choice" too, so an interrupted tap-through stored a destination
 * nobody picked. Opening the menu and dismissing it changes nothing.
 *
 * Renders nothing when there is nowhere else to send — a user with no linked
 * cross-post destinations has no choice to make.
 *
 * The help desk is NOT one of these, and has no composer control at all.
 * Talking to support is not a place a message goes, and putting it in this
 * cycle would make every user stepping from the site to Twitch pass through a
 * support conversation. It is reached by `/support`, by the greeting bubble,
 * and from the panel — never from this row.
 */
export function SendToButton({ destCycle, forcedDest, onPick, onDisarm, onRetry, refusals, binding }: SendToButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The menu is portalled to <body>, so it needs its own ref to count as "inside".
  const popRef = useRef<HTMLDivElement>(null);
  useOutsideClick([wrapRef, popRef], () => setOpen(false), { enabled: open, escape: true });
  // A bound window must show its face even for a user with no cross-post
  // destinations — a DM is a place a message goes whether or not Twitch is linked.
  if (!binding && destCycle.length <= 1) return null;
  if (binding) {
    const { label, avatarUrl } = binding.face;
    return (
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={binding.release}
        title={`Sending to ${label} — click to stop`}
        aria-label={`Sending to ${label}. Click to stop and send to chat again.`}
        className={`${ctlClass(true)} mx-0 chat-sendto-btn`}
        style={ctlBox}
        data-binding="sendTo"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-[1em] w-[1em] rounded-full object-cover" />
        ) : (
          <Chats size="0.95em" weight="fill" />
        )}
      </button>
    );
  }

  // "<site> · redacted", not just "redacted" — the destination has not
  // changed, only the hiding has. Naming it as its own place would suggest the message goes
  // somewhere else, which is exactly the thing it never does.
  const encrypted = forcedDest === ENCRYPTED_DEST;
  const label = encrypted ? `${siteName()} · redacted` : destLabel(forcedDest);
  // The chosen platform refused for good this session: say so on the button too,
  // since its lines are quietly posting here only.
  const quiet = !encrypted && forcedDest ? refusals?.get(forcedDest) : undefined;
  const why = quiet ? ` (${refusalState(quiet)} — posting here only)` : "";

  return (
    <span ref={wrapRef} className="contents">
    <button
      ref={btnRef}
      type="button"
      // Tapping the destination must not dismiss the keyboard mid-message.
      onMouseDown={keepFocus}
      onClick={encrypted ? onDisarm : () => setOpen((v) => !v)}
      title={encrypted ? `Send to: ${label} — click to stop redacting` : `Send to: ${label}${why} — click to choose`}
      aria-label={encrypted ? `Send to ${label}. Click to stop redacting.` : `Send to ${label}${why}. Click to choose where messages go.`}
      aria-haspopup={encrypted ? undefined : "menu"}
      aria-expanded={encrypted ? undefined : open}
      // Size and skin come from lib/composerControls — the measurement that used
      // to live here (1.8 em of --chat-font-size, tracking the field's rendered
      // height at any chat size) is now the shared CTL_SIZE every control uses.
      // Spacing is the row's `gap`, not per-button margins.
      className={`${ctlClass(!!forcedDest)} mx-0 chat-sendto-btn`}
      style={{
        ...ctlBox,
        ...(encrypted
          ? { color: "var(--color-encrypted)" }
          : forcedDest && forcedDest !== "all"
            ? { color: PLATFORM_COLORS[forcedDest] }
            : {}),
      }}
    >
      {encrypted ? (
        <Lock size="0.95em" weight="fill" />
      ) : !forcedDest ? (
        <Chats size="0.95em" weight="bold" />
      ) : forcedDest === "all" ? (
        <Broadcast size="0.95em" weight="regular" />
      ) : (
        <PlatformIcon platform={forcedDest} size="0.9em" />
      )}
    </button>
    {open && (
      <ComposerPopover innerRef={popRef} anchorRef={btnRef} align="left" barTop width={220} maxHeight={280} className="text-xs">
        <div role="menu" aria-label="Send messages to">
          <p className="px-3 pt-2 pb-1 text-muted">Send messages to</p>
          {destCycle.map((d) => {
            const on = d === forcedDest;
            const state = d ? refusals?.get(d) : undefined;
            return (
              <button
                key={d ?? "native"}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onMouseDown={keepFocus}
                // Picking the entry already selected changes nothing — except that it
                // is how a person says "try Kick again" after following there.
                onClick={() => { setOpen(false); onRetry?.(d); if (!on) onPick(d); }}
                className="w-full px-3 py-2 text-left text-body-dim hover:bg-surface-2 flex items-center gap-2 transition-colors"
              >
                <span className="flex w-4 items-center justify-center" style={d && d !== "all" ? { color: PLATFORM_COLORS[d] } : undefined}>
                  {d === null ? <Chats size="1em" weight="bold" /> : d === "all" ? <Broadcast size="1em" /> : <PlatformIcon platform={d} size="0.9em" />}
                </span>
                <span className="flex-1">
                  {destLabel(d)}
                  {state && <span className="text-muted">: {refusalState(state)}</span>}
                </span>
                {on && <Check size="1em" weight="bold" aria-hidden />}
              </button>
            );
          })}
        </div>
      </ComposerPopover>
    )}
    </span>
  );
}

/** A destination as the menu and the button name it. */
function destLabel(d: string | null): string {
  if (d === null) return `${siteName()} only`;
  if (d === "all") return "All linked platforms";
  return platformLabel(d);
}

/**
 * "You are talking to the help desk" — shown ONLY while support mode is actually armed,
 * and clicking it leaves.
 *
 * This is an INDICATOR, not an entry point. The desk in the destination toggle
 * would make everyone stepping from the site to Twitch pass through a support
 * conversation, and a permanent button of its own would be the same mistake in
 * a new place. You enter support by the `/support` command, the greeting
 * bubble or the panel, and this appears only once you are in, so it can never
 * be something you land on by accident.
 *
 * It therefore has NO `armed` prop. The caller renders it only when support is
 * live, which means there is no such thing as an unarmed SupportButton and no
 * second visual state anyone can get wrong.
 */
export function SupportButton({ onLeave }: { onLeave: () => void }) {
  const label = `Talking to ${useBotName("Help")} — click to go back to chat`;
  return (
    <button
      type="button"
      // Same reason as the destination button: tapping must not dismiss the
      // soft keyboard in the middle of a support conversation.
      onMouseDown={keepFocus}
      onClick={onLeave}
      title={label}
      aria-label={label}
      className={`${ctlClass(true)} mx-0`}
      style={{ ...ctlBox, color: "var(--color-support)" }}
    >
      {/* The bot's pfp IS the signal — deliberately not a token. The PUBLIC avatar
          route, not the per-viewer one: this button renders for signed-out
          visitors too, and /api/avatar/user needs the VIEWER's Matrix token, so
          it served everyone a letter circle. 404 here keeps the letter fallback. */}
      <img
        src="/api/avatar/public/bot"
        alt="" aria-hidden
        className="rounded-full object-cover"
        style={{ width: "1.1em", height: "1.1em" }}
      />
    </button>
  );
}
