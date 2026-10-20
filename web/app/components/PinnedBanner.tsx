"use client";

import { useState, useLayoutEffect, useRef } from "react";
import { PushPin, PushPinSlash } from "@phosphor-icons/react/dist/ssr";
import { renderText } from "@/app/lib/renderText";
import { useSetting } from "@/app/lib/useSetting";
import { CHAT_FONT, rowBasisCalc } from "@/app/lib/chatFont";
import { DEFAULT_NAME_COLOR, readableColor } from "@/app/lib/colors";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { usernameStyleCSS, usernameStyleAnimClass } from "@/app/lib/usernameStyles";
import { useNameInk } from "@/app/lib/nameInk";
import { useAnimFenceRef } from "@/app/lib/animFence";
import type { EmoteMap } from "@/app/lib/useEmotes";

export type { PinnedMessage } from "@/app/lib/pinnedMessage";
import type { PinnedMessage } from "@/app/lib/pinnedMessage";

// Twitch-style single-pin banner above the live chat. Opens EXPANDED — the
// whole message, wrapped — and a tap collapses it to one line.
// The PIN ICON is the control: it unpins globally for mods and just hides the
// banner locally for everyone else. There is no ✕ — in the /chat window the
// gear already takes the top-right corner, and a second control beside it would
// be width the message cannot use.
//
// The text is set like a chat row — it wears the row's own `chat-msg-body`
// class and the same size / line-height / font / weight variables, and the name
// takes the username settings — so every chat text setting reaches it.
//
// The name wears what the author's chat rows wear: the equipped style set
// (usernameStyleCSS, on the author's own colour — the site colour, or the
// platform's per-user colour, else the same default a chat row falls back to)
// and the badge row before it (BadgesContext, keyed on the author's matrix
// id, sized by the viewer's badge-size setting like every other badge row).
// All of it comes from the pin frame's `matrixId` / `usernameColor` /
// `usernameStyle`, which the server resolves LIVE at read time
// (lib/pinAuthor.ts) — an older pin, or an unlinked platform chatter,
// simply has none and renders a plain name.
//
// It OVERLAYS the top of the message list (absolute) rather than sitting in the
// flow, so the chat scrolls *behind* it. The list pads its top by the banner's
// measured height (reported via onHeightChange) so nothing hides under it at rest.
//
// It FLOATS: a rounded, bordered card held off the top and sides. The gap is
// PADDING on the outer, measured box — so the height the list pads by covers
// the card and the gaps around it — and that outer box passes clicks through,
// so the strip beside and under the card is still the chat.
//
// No backdrop-filter: its backdrop is the chat, so a blur here re-rasterizes on
// every scroll frame — exactly when frames are scarce on a phone — and every
// other non-pop-up glass surface is already gated behind `!narrow`. A banner is
// not a pop-up, so it keeps the translucent fill and has no blur.
// Do NOT reintroduce a backdrop-filter here; glassSurface.test.ts fails if you do.
export default function PinnedBanner({
  pin,
  emotes,
  isMod,
  onUnpin,
  onDismiss,
  onHeightChange,
}: {
  pin: PinnedMessage;
  emotes: EmoteMap;
  isMod: boolean;
  onUnpin: () => void;
  onDismiss: () => void;
  onHeightChange?: (h: number) => void;
}) {
  // Behavior › Hide swear words — a pin is chat text too (one banner, so it reads the setting itself).
  const maskSwears = useSetting("chatStyle_profanityFilter") === "1";
  // "Expanded by default" has to hold for EVERY pin, not the first one after
  // a reload: this component stays mounted while pins replace each other
  // (auto-pins at +5 all stream, a mod pin over an auto pin), so a boolean
  // that starts true would carry a viewer's collapse to every later pin. The
  // state is WHICH pin was collapsed; a new pin is expanded by derivation, no
  // effect needed.
  const [collapsedPinId, setCollapsedPinId] = useState<number | null>(null);
  const expanded = collapsedPinId !== pin.id;
  const ref = useRef<HTMLDivElement>(null);
  const badgeState = useBadges();
  const badges = badgesForMatrixId(badgeState, pin.matrixId);
  // The same clamp a chat row applies (ChatMessage): near-black colours are
  // lightened so the name stays legible on the dark fill.
  const nameColor = readableColor(pin.usernameColor ?? DEFAULT_NAME_COLOR);
  const nameAnimClass = usernameStyleAnimClass(pin.usernameStyle);
  const nameInkRef = useNameInk(pin.usernameStyle?.font, pin.username);
  // Paused only while off screen — e.g. the chat pane hidden on the Home tab.
  const nameRef = useAnimFenceRef(nameAnimClass !== "", nameInkRef);
  const pinControlLabel = `${pin.auto ? "Pinned by chat (+5)" : "Pinned by a moderator"} — click to ${isMod ? "unpin for everyone" : "hide"}`;

  // Report the live height (it changes when expanded toggles or the message
  // reflows) so the scroll area can pad its top to match. Reset to 0 on unmount
  // so the padding releases when the banner is dismissed/unpinned.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onHeightChange) return;
    const ro = new ResizeObserver(() => onHeightChange(el.offsetHeight));
    ro.observe(el);
    onHeightChange(el.offsetHeight);
    return () => { ro.disconnect(); onHeightChange(0); };
  }, [onHeightChange]);

  return (
    <div
      ref={ref}
      className="absolute top-0 left-0 right-0 z-10 p-1.5 pointer-events-none"
    >
      <div
        className="pin-card rounded-lg border pointer-events-auto"
        style={{
          background: "var(--glass-bg, rgba(12,16,28,0.82))",
          borderColor: "var(--pin-border, rgba(255,255,255,0.10))",
          boxShadow: "var(--pin-shadow, 0 4px 14px rgba(0,0,0,0.5))",
        }}
      >
        <div className="pin-row flex items-start gap-2 px-3 py-1.5">
          {/* One colour, like the community's pin marks — it takes the muted
              text colour and the row's font size, and sits on the first line.
              Pointing at it shows what a click does. */}
          <button
            type="button"
            data-pin-control
            onClick={isMod ? onUnpin : onDismiss}
            title={pinControlLabel}
            aria-label={pinControlLabel}
            className="group shrink-0 inline-flex items-center text-muted hover:text-strong focus-visible:text-strong transition-colors"
            style={{ fontSize: CHAT_FONT, lineHeight: "var(--chat-line-height, 1.4)", height: "1lh" }}
          >
            <PushPin size="1em" weight="bold" className="group-hover:hidden group-focus-visible:hidden" />
            <PushPinSlash size="1em" weight="bold" className="hidden group-hover:block group-focus-visible:block" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsedPinId((c) => (c === pin.id ? null : pin.id))}
            className="chat-msg-body flex-1 min-w-0 text-left break-words"
            style={{
              fontSize: CHAT_FONT,
              lineHeight: "var(--chat-line-height, 1.4)",
              fontFamily: "var(--chat-font-family, inherit)",
              fontWeight: "var(--chat-font-weight, 400)" as React.CSSProperties["fontWeight"],
            }}
          >
            {badges.length > 0 && (
              // Before the name, the chat row's badge row (same class, same gap
              // tokens) — sized in em so it follows the banner's own font size.
              <span className="chat-badges" style={{ display: "inline-flex", alignItems: "center", gap: "var(--chat-badge-gap)", verticalAlign: "middle", marginRight: "var(--chat-badge-gap)" }}>
                {badges.map((b) => (
                  <img key={b.id} src={b.imageUrl} alt={b.name} title={b.name} style={{ height: rowBasisCalc('1.10 * var(--chat-badge-scale, 1)'), width: "auto", display: "inline-block", verticalAlign: "middle" }} />
                ))}
              </span>
            )}
            {/* The name, as a chat row sets it: the viewer's username font /
                weight / saturation outside, and the author's equipped
                style set (font / effect / gradient) wrapping ONLY the name
                inside, spread over the base colour. */}
            <span
              data-pin-name=""
              style={{
                color: nameColor,
                filter: "saturate(var(--chat-username-sat, 1))",
                fontFamily: "var(--chat-username-font, inherit)",
                fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"],
                fontSize: CHAT_FONT,
              }}
            >
              <span
                ref={nameRef}
                className={nameAnimClass || undefined}
                style={usernameStyleCSS(pin.usernameStyle, pin.usernameColor ?? nameColor)}
              >
                {pin.username}
              </span>
            </span>
            {/* The chat row's colon: plain and muted, outside the style set. */}
            <span className="text-muted mr-1.5">:</span>
            <span className={expanded ? "break-words" : "line-clamp-1"} style={{ color: "var(--chat-text-color, #e8e6e3)" }}>
              {renderText(pin.message, emotes, pin.emotes, undefined, { mask: maskSwears })}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
