"use client";

import { CHAT_FONT, CHAT_FONT_SM } from "@/app/lib/chatFont";
import React, { useLayoutEffect, useRef } from "react";
import EmotePicker from "./EmotePicker";
import { Smiley } from "@phosphor-icons/react/dist/ssr";
import { keepFocus } from "@/app/lib/keepFocus";
import { CTL_SIZE } from "@/app/lib/composerControls";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { Q_POINTER_COARSE } from "@/app/lib/deviceQueries";
import { CharCounter } from "./CharCounter";
import { preparePicker } from "@/app/lib/emotePickerWarm";

const NO_EMOTES: EmoteMap = {};

type RefusalNoteProp = {
  /** The full sentence: the title, and what a screen reader hears. */
  text: string;
  /** Every length of it, longest first; the longest that fits the field is shown. */
  forms?: string[];
  onDismiss: () => void;
};

/**
 * The refusal note's line. NEVER A CUT SENTENCE: no fixed breakpoint can be right
 * — the width it gets depends on the chat font size (a setting), the platform's
 * name and the controls sharing the row — so it MEASURES. An invisible,
 * out-of-flow copy of each form gives its natural width; the longest that fits
 * the slot is shown, the rest are `hidden`. Only below the shortest form does the
 * last one truncate, and the full sentence is always in the title and the
 * sr-only text. The choice is applied to the DOM directly (a layout effect,
 * before paint) — no state, so no extra render per resize.
 *
 * pointer-events off on the line (a tap still lands in the field and focuses
 * it), on for the ✕. `right-9` keeps it clear of the emote button.
 */
function RefusalNoteLine({ note }: { note: RefusalNoteProp }) {
  const forms = note.forms?.length ? note.forms : [note.text];
  const slotRef = useRef<HTMLSpanElement>(null);
  const key = forms.join("\n");
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const measure = () => {
      const avail = slot.clientWidth;
      const copies = [...slot.querySelectorAll<HTMLElement>("[data-note-form]")];
      const found = copies.findIndex((c) => c.scrollWidth <= avail);
      const pick = found < 0 ? copies.length - 1 : found;
      slot.querySelectorAll<HTMLElement>("[data-note-option]").forEach((o, i) => {
        o.hidden = i !== pick;
        o.toggleAttribute("data-note-shown", i === pick);
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(slot);
    return () => ro.disconnect();
  }, [key]);
  return (
    <span
      data-refusal-note
      role="status"
      title={note.text}
      className="absolute inset-y-0 left-0 right-9 flex items-center gap-1.5 pl-4 leading-tight text-secondary pointer-events-none select-none min-w-0"
      style={{ fontSize: CHAT_FONT_SM, fontFamily: "var(--chat-font-family, inherit)" }}
    >
      <span className="sr-only">{note.text}</span>
      <span ref={slotRef} data-note-slot className="relative flex-1 min-w-0 overflow-hidden">
        {forms.map((f, i) => (
          <span key={`m${i}`} data-note-form aria-hidden="true" className="invisible absolute left-0 top-0 whitespace-nowrap">{f}</span>
        ))}
        {forms.map((f, i) => (
          <span key={`o${i}`} data-note-option aria-hidden="true" className="block truncate">{f}</span>
        ))}
      </span>
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={note.onDismiss}
        aria-label="Dismiss"
        className="shrink-0 pointer-events-auto text-muted hover:text-strong"
      >
        ✕
      </button>
    </span>
  );
}

/**
 * The shared message-entry field: an auto-sizing textarea with an emote button
 * pinned inside it and the emote picker popover. Used by both the live-chat
 * composer (ChatInput) and the Matrix composer (MatrixInput).
 *
 * It owns no message/submit logic — value, key handling, and submit live in the
 * parent. The emote-picker open state is lifted to the parent too, because the
 * parent closes the picker on submit/Escape.
 */
export function ChatComposerField({
  value,
  onChange,
  onKeyDown,
  onSelect,
  inputRef,
  emotes,
  personalEmotes,
  personalNeedsRelink,
  maxLength,
  counterMax,
  placeholder,
  note = null,
  disabled,
  showEmotePicker,
  setShowEmotePicker,
  /** ChatInput skips focus on coarse pointers so picking doesn't pop the soft keyboard. */
  focusAfterPick = "always",
  expanded = false,
  accentColor = null,
  onFocus,
  onBlur,
  combobox,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Fires on caret/selection change — used to anchor mid-word emote completion. */
  onSelect?: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  emotes: EmoteMap;
  /** The signed-in user's own Twitch emotes, unmerged — forwarded straight to
   *  EmotePicker's "Your emotes" section (see emotePickerSections.ts). */
  personalEmotes?: EmoteMap;
  /** Twitch is linked but predates the emote-read scope — shows the picker's re-link nudge. */
  personalNeedsRelink?: boolean;
  maxLength: number;
  /** When set, a "characters left" counter appears inside the field as the
   *  draft nears this number — only while expanded, since a collapsed field
   *  is one line and never near a limit. */
  counterMax?: number;
  placeholder?: string;
  /**
   * One calm line shown IN the empty field, in the placeholder's place — the
   * composer's refusal note (platformRefusals.ts). Inside the field on purpose:
   * absolutely positioned, it can neither grow the Bar (and so shrink and shift
   * the chat list) nor cover the chat, which a row above the field or a popup
   * would. Hidden while there is a draft; the ✕ dismisses it.
   */
  note?: RefusalNoteProp | null;
  disabled?: boolean;
  showEmotePicker: boolean;
  setShowEmotePicker: React.Dispatch<React.SetStateAction<boolean>>;
  focusAfterPick?: "always" | "fine-pointer";
  /** Grown state: the field may run to several lines and relaxes its pill. Driven
   *  by the parent (focused AND has text) so a draft you have clicked away from
   *  stops eating the chat. */
  expanded?: boolean;
  /**
   * Destination signal, as a CSS colour — see `composerAccent`. Colours the
   * field's BORDER only, never its fill: the field is a text surface and the
   * platform palette is pastel, so even a 10% background tint lifts the field
   * enough to drop the placeholder (`text-muted`, 3.84:1 over surface-1) to
   * roughly 2:1. `null` = no signal, field keeps its neutral edge.
   * ChatInput passes it; the Matrix composer does not — a room has exactly one
   * destination, so there is nothing to signal there.
   */
  accentColor?: string | null;
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * Combobox wiring for the typeahead overlays the PARENT renders (emote/
   * mention completion, the `/` palette) — the field itself owns no popup, so
   * only the consumer can say whether one is open and which option the arrows
   * are on. All three consumers pass it (typeaheadCombobox.test.ts).
   */
  combobox?: {
    expanded: boolean;
    /** id of the OPEN listbox — dangling while closed, hence gated below. */
    controls: string | undefined;
    activeDescendant: string | undefined;
  };
}) {
  // The picker is portalled, so it needs a real element to anchor against
  // rather than an `absolute` parent.
  const emoteBtnRef = useRef<HTMLButtonElement>(null);
  const warmPicker = () => preparePicker(emotes, personalEmotes ?? NO_EMOTES);

  return (
    <div className="relative flex-1 min-w-0">
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onSelect={onSelect}
        maxLength={maxLength}
        // NO NATIVE `placeholder` — it is rendered as an overlay below.
        //
        // A textarea's placeholder is real content for `fieldSizing: content`,
        // and it WRAPS like any other text. At 390px "Send a message…" needs
        // two lines, which pushes the field past its collapsed ceiling
        // (CTL_SIZE) and makes `overflow-y: auto` paint a scrollbar beside an
        // EMPTY field. ::placeholder cannot fix that: per spec
        // it only accepts the ::first-line properties, so `white-space` and
        // `text-overflow` do not apply, and the wrapping is inherited from the
        // textarea itself — which cannot be set to nowrap without breaking
        // every real multi-line draft.
        //
        // The placeholder would also be the field's accessible name, so it
        // moves to aria-label.
        aria-label={placeholder}
        // The page's only Send key: this field sends on Enter; the terminal's box does not say Send.
        enterKeyHint="send"
        // Combobox only when a consumer wired one — the role PROMISES a popup,
        // and the aria-controls/-activedescendant ids must not dangle while the
        // popup is closed (they'd point at elements that don't exist).
        role={combobox ? "combobox" : undefined}
        aria-autocomplete={combobox ? "list" : undefined}
        aria-expanded={combobox ? combobox.expanded : undefined}
        aria-controls={combobox?.expanded ? combobox.controls : undefined}
        aria-activedescendant={combobox?.expanded ? combobox.activeDescendant : undefined}
        disabled={disabled}
        // Focusing the field is intent to write — maybe with emotes: start the
        // picker's first screens now so it opens painted (emotePickerWarm).
        onFocus={() => { warmPicker(); onFocus?.(); }}
        onBlur={onBlur}
        // Shape and growth are STATEFUL — see `.chat-input-field` in globals.css.
        //   • at rest: a one-line pill (radius 999px)
        //   • expanded: up to 7 lines, radius relaxed to 1rem so the curve stops
        //     clipping the first/last characters of the top and bottom rows
        //
        // `bg-surface-1`, a step DEEPER than the row it sits in — the field is
        // a well, the controls beside it are raised. Both at `surface-2`, the
        // row would read as one undifferentiated grey slab.
        // NO focus ring. A 1px ring is painted as a box-shadow just outside a 1px
        // border in a near-identical colour — two soft edges stacked, which reads
        // as a thick blurry outline rather than a crisp one. The
        // focused state is carried by the border alone, brightened one step.
        className={`chat-input-field${expanded ? " is-expanded" : ""} block w-full bg-surface-1 border border-edge px-4 py-1 outline-none focus:border-edge-bright resize-none leading-tight`}
        // The bottom Bar grows past its token only for a descendant that says
        // so (chrome.css) — the field is the one that knows.
        data-chrome-grow={expanded || undefined}
        // A DATA ATTRIBUTE drives the accent, not a class and not an inline
        // borderColor. Inline styles beat the `focus:border-edge-bright`
        // utility unconditionally, which would freeze the border at one colour
        // and cost the field its focus affordance — the border is the ONLY thing
        // carrying focus here (there is deliberately no ring). The attribute
        // lets globals.css express rest and focus as two ordinary rules.
        data-accent={accentColor ? "on" : undefined}
        style={{
          ...(accentColor ? { "--composer-accent": accentColor } : null),
          fontSize: CHAT_FONT,
          fontFamily: "var(--chat-font-family, inherit)",
          color: "var(--chat-text-color, #e8e6e3)",
          // Collapsed height is the control diameter, so a field you have
          // clicked away from lines up with the buttons exactly and a long draft
          // stops eating the chat above it. `fieldSizing: content` grows it up to
          // this ceiling; the ceiling is what actually animates.
          // Collapsed = exactly ONE natural line (the same expression the control
          // diameter is built from), so settling never squeezes the text.
          maxHeight: expanded ? `calc(${CHAT_FONT} * 7)` : CTL_SIZE,
          // Scrollable ONLY when expanded. A real draft past the expanded
          // 7-line ceiling still has to scroll; collapsed, the field holds at
          // most one line, so there is nothing to scroll to and `auto` could
          // only ever produce a phantom bar.
          overflowY: expanded ? "auto" : "hidden",
          fieldSizing: "content",
        } as React.CSSProperties}
      />
      {/* The placeholder, as an ordinary element so it can actually be
          truncated: `truncate` = nowrap + hidden + ellipsis, none of which the
          native ::placeholder honours. Absolutely positioned, so it never
          contributes to `fieldSizing: content` and cannot change the field's
          height at any width. Hidden from the a11y tree — the same string is
          the textarea's aria-label, and announcing it twice is worse than not
          at all.
          Only ever visible while the field is EMPTY, which is also the only
          time the field is guaranteed collapsed (`expanded` = focused AND has
          text), so a single centred line is the whole story. */}
      {/* Shown whenever the field is EMPTY — focused or not: focus alone never
          hides it (only a draft does). */}
      {!value && note && <RefusalNoteLine note={note} />}
      {!value && !note && placeholder && (
        <span
          aria-hidden="true"
          // `text-muted`: a raw white-25% placeholder composites to
          // rgb(78,78,80) on the field — 2.24:1, which fails AA outright. Of the
          // ladder's rungs, `faint` (1.78:1) is DARKER and the wrong direction;
          // `muted` lands at 3.84:1 and still reads clearly as a placeholder.
          className="chat-input-placeholder absolute inset-0 px-4 py-1 leading-tight truncate text-muted pointer-events-none select-none"
          style={{
            fontSize: CHAT_FONT,
            fontFamily: "var(--chat-font-family, inherit)",
          }}
        >
          {placeholder}
        </span>
      )}
      {/* The emote button is the ONLY thing still inside the field, and it stays
          there on purpose: it acts on the text you are writing, so it belongs in
          the text's box. Everything that acts on the MESSAGE (tools, destination,
          attach) now lives outside — which is also what let the field's
          right-inset rules collapse from a four-way matrix to one. */}
      <div
        className="absolute right-2 top-1 bottom-1 flex items-center"
        style={{ fontSize: CHAT_FONT }}
      >
        <button
          ref={emoteBtnRef}
          type="button"
          onClick={() => setShowEmotePicker((p) => !p)}
          onMouseDown={keepFocus}
          // Reaching for the button (hover / keyboard focus / the press before the
          // click) starts the picker's first screens — see emotePickerWarm.
          onPointerEnter={warmPicker}
          onPointerDown={warmPicker}
          onFocus={warmPicker}
          title="Emotes"
          aria-label="Emotes"
          className={`chat-emote-btn items-center justify-center rounded-full transition-colors ${
            showEmotePicker ? "text-strong" : "text-secondary hover:text-body"
          }`}
        >
          <Smiley size="1.1em" weight={showEmotePicker ? "fill" : "bold"} />
        </button>
      </div>
      {counterMax != null && expanded && (
        <CharCounter
          length={value.length}
          max={counterMax}
          className="absolute right-10 bottom-1 pointer-events-none select-none"
          style={{ fontSize: CHAT_FONT }}
        />
      )}
      {showEmotePicker && (
        <EmotePicker
          anchorRef={emoteBtnRef}
          emotes={emotes}
          personal={personalEmotes}
          personalNeedsRelink={personalNeedsRelink}
          onSelect={(name) => {
            onChange(value + name + " ");
            const coarse = typeof window !== "undefined" && window.matchMedia(Q_POINTER_COARSE).matches;
            if (focusAfterPick === "always" || !coarse) inputRef.current?.focus();
          }}
          onClose={() => setShowEmotePicker(false)}
        />
      )}
    </div>
  );
}
