"use client";

import { useState, useRef } from "react";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { ChartBar, Plus, Sticker, Lock } from "@phosphor-icons/react/dist/ssr";
import PointsIcon from "./PointsIcon";
import EmotePicker from "./EmotePicker";
import { ComposerPopover } from "./ComposerPopover";
import { keepFocus } from "@/app/lib/keepFocus";
import { ctlBox, ctlClass, CTL_ICON } from "@/app/lib/composerControls";
import type { ChatMsg } from "@/app/lib/chatMsg";
import type { EmoteMap } from "@/app/lib/useEmotes";

/** Mirrors SpendChip.tsx's SpendMode — redeclared, not imported. This file
 *  lives outside the chat feature, and importing past that feature's public
 *  API (its index.ts) would trip check-structure's encapsulation rule. */
type SpendMode = "highlight" | "tts";

type ComposerToolsPopoverProps = {
  matrixId: string | null;
  spendMode: SpendMode | null;
  setSpendMode: (m: SpendMode | null) => void;
  /** Live prices, passed down from ChatInput — this popover must not open its
   *  own price subscription. */
  highlightPrice: number;
  ttsPrice: number;
  replyTo: ChatMsg | null;
  onOpenPoll: () => void;
  stickerBusy: boolean;
  /** Live sticker price; null while the table is unknown — the row disables
   *  rather than showing a constant nobody can change between streams. */
  stickerPrice: number | null;
  sendSticker: (name: string) => void;
  emotes: EmoteMap;
  /** Fold the control away while the composer has text. */
  collapsed?: boolean;
  /**
   * Encrypted-message state, for the row below.
   * `canEncrypt` is tri-state: `null` = the subscription read has not landed.
   */
  canEncrypt: boolean | null;
  encryptArmed: boolean;
  onToggleEncrypt: () => void;
};

// Composer tools: poll, highlight/read-aloud spend, sticker behind one + button.
//
// It sits OUTSIDE the typing field, in the left control group. That is not
// only cosmetic — inside the field, the field would have to reserve right-hand
// padding for it. Outside, the field has one job.
//
// The icon is `+`: as the leading control of the row it is the familiar
// "attach something to this message" affordance, which is what a poll, a
// spend and a sticker all are.
//
// The trigger still surfaces armed spend state (gold Qorm icon) — an armed
// spend costs real currency on the next Enter, so it must never be invisible.
export function ComposerToolsPopover({
  matrixId, spendMode, setSpendMode, highlightPrice, ttsPrice,
  replyTo, onOpenPoll, stickerBusy, stickerPrice, sendSticker, emotes, collapsed = false,
  canEncrypt, encryptArmed, onToggleEncrypt,
}: ComposerToolsPopoverProps) {
  const [showTools, setShowTools] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // BOTH refs, and the second one is essential. `toolsRef` sits on the
  // `display: contents` wrapper below, which contains the trigger and — in the
  // REACT tree — the popover. `useOutsideClick` asks `contains()`, which walks
  // the DOM, and the popover is portalled to <body>. So without `popRef` every
  // press on a row is an outside press: on a desktop ComposerPopover stops
  // `mousedown`, but on a phone the hook's `touchstart` listener gets through
  // and closes the menu before the tap becomes a click. `popRef` points at the
  // portal root, so containment is true again.
  //
  // The array form is load-bearing — the trigger must stay "inside" too, or
  // pressing + to close it counts as an outside press and fights the toggle.
  useOutsideClick([toolsRef, popRef], () => setShowTools(false), { enabled: showTools });

  // Folding away while the menu is open would leave an orphaned popover with no
  // trigger to close it from.
  //
  // Adjusted DURING RENDER, not in an effect — React's "adjusting state when a
  // prop changes" shape. A synchronous setState inside an effect is a cascading
  // re-render, and an eslint error under this config.
  const [wasCollapsed, setWasCollapsed] = useState(collapsed);
  if (collapsed !== wasCollapsed) {
    setWasCollapsed(collapsed);
    if (collapsed && showTools) setShowTools(false);
  }

  const [showStickerPicker, setShowStickerPicker] = useState(false);

  if (!matrixId) return null;

  const row = "w-full px-3 py-2 text-left text-body-dim hover:bg-surface-2 flex items-center gap-2 transition-colors disabled:opacity-40";

  return (
    <div ref={toolsRef} className="contents">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setShowTools((v) => !v)}
        onMouseDown={keepFocus}
        title="Message tools"
        aria-label="Message tools"
        aria-expanded={showTools}
        className={`composer-collapsible chat-tools-btn ${ctlClass(showTools || spendMode !== null)}`}
        data-collapsed={collapsed ? "true" : "false"}
        style={{ ...ctlBox, ...(spendMode !== null ? { color: "#eab308" } : {}) }}
      >
        {spendMode !== null
          ? <PointsIcon size={CTL_ICON} />
          : <Plus size={CTL_ICON} weight="bold" style={{ transition: "transform var(--anim-fast) var(--anim-ease)", transform: showTools ? "rotate(45deg)" : "none" }} />}
      </button>

      {/* Portalled: the composer lives inside an `overflow: hidden` column, so an
          in-flow popover gets clipped rather than overflowing. */}
      {showTools && (
        <ComposerPopover innerRef={popRef} anchorRef={btnRef} width={210} maxHeight={260} className="text-xs">
          <button type="button" onClick={() => { setShowTools(false); onOpenPoll(); }} className={row}>
            <span className="flex w-4 items-center justify-center"><ChartBar size="1em" weight="bold" /></span>
            Start a poll
          </button>
          <button
            type="button"
            disabled={!!replyTo}
            title={replyTo ? "Buying is paused while replying" : undefined}
            onClick={() => { setSpendMode(spendMode === "highlight" ? null : "highlight"); setShowTools(false); }}
            className={`${row} border-t border-edge`}
          >
            <span className="flex w-4 items-center justify-center"><PointsIcon size="1em" /></span>
            {spendMode === "highlight" ? "Cancel highlight" : "Highlight message"}
            {spendMode !== "highlight" && <span className="ml-auto text-muted">{highlightPrice}</span>}
          </button>
          <button
            type="button"
            disabled={!!replyTo}
            title={replyTo ? "Buying is paused while replying" : undefined}
            onClick={() => { setSpendMode(spendMode === "tts" ? null : "tts"); setShowTools(false); }}
            className={`${row} border-t border-edge`}
          >
            <span className="flex w-4 items-center justify-center"><PointsIcon size="1em" /></span>
            {spendMode === "tts" ? "Cancel read aloud" : "Read aloud"}
            {spendMode !== "tts" && <span className="ml-auto text-muted">{ttsPrice}</span>}
          </button>
          <button
            type="button"
            disabled={stickerBusy || stickerPrice === null}
            title={stickerPrice === null ? "Sticker price is still loading" : undefined}
            onClick={() => { setShowTools(false); setShowStickerPicker(true); }}
            className={`${row} border-t border-edge`}
          >
            <span className="flex w-4 items-center justify-center text-yellow-500/90"><Sticker size="1em" weight="bold" /></span>
            Send a sticker <span className="ml-auto text-muted">{stickerPrice ?? "\u2014"}</span>
          </button>
          {/*
            The one place to arm whole-message redaction by tap: the lock is out
            of the send-to cycle, so a fast tap-through never lands on it. It is
            also the one place a NON-Supporter learns this exists — a disabled
            row that says why, not a hidden one.
          */}
          <button
            type="button"
            disabled={canEncrypt === false}
            title={
              canEncrypt === false ? "Redacted messages are a Supporter perk"
              : encryptArmed ? "Send normally instead"
              : "Redact your messages until you turn it off — only Supporters can read them. /r redacts just one, and ||two bars|| hide part of one."
            }
            onClick={() => { onToggleEncrypt(); setShowTools(false); }}
            className={`${row} border-t border-edge`}
          >
            <span
              className="flex w-4 items-center justify-center"
              style={encryptArmed ? { color: "var(--color-encrypted)" } : undefined}
            >
              <Lock size="1em" weight={encryptArmed ? "fill" : "bold"} />
            </span>
            {encryptArmed ? "Stop redacting" : "Redacted message"}
            {canEncrypt === false && <span className="ml-auto text-muted">Supporters</span>}
          </button>
        </ComposerPopover>
      )}

      {/* Sticker pick = the spend (server resolves + throttles). */}
      {showStickerPicker && (
        <EmotePicker
          anchorRef={btnRef}
          emotes={emotes}
          onSelect={(name) => { setShowStickerPicker(false); sendSticker(name); }}
          onClose={() => setShowStickerPicker(false)}
        />
      )}
    </div>
  );
}
