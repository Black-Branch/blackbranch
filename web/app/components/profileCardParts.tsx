"use client";

import { useCallback, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { avatarBg, hashHue } from "@/app/lib/avatarColor";
import { CHAT_FONT, rowBasisCalc } from "@/app/lib/chatFont";
import { mxcToScaled, onScaledError } from "@/app/lib/matrixMedia";
import { useNameInk, useEntranceReplay, fitZoom } from "@/app/lib/nameInk";
import { useAnimFenceRef } from "@/app/lib/animFence";
import {
  usernameStyleCSS, usernameStyleAnimClass, type EquippedStyle,
} from "@/app/lib/usernameStyles";
import type { BadgeDef } from "@/app/lib/BadgesContext";

// Presentation shared by the two profile surfaces: the own-view ProfileCard (a
// Window dialog) and the public UserCard (a floating draggable card). Only
// the pieces BOTH render identically live here — each card keeps its own frame,
// data fetching, identity line, and the rows/actions unique to it. Share what's
// identical, not what merely looks similar.

// Per-user banner gradient, derived from the same hash as the avatar fallback so
// a card reads as "theirs" without any uploaded image. bg-surface-3 is the
// pre-paint fill behind it.
function bannerGradient(displayName: string): string {
  const hue = hashHue(displayName);
  return `linear-gradient(135deg, ${avatarBg(displayName)}, hsl(${(hue + 40) % 360}, 45%, 20%))`;
}

/**
 * Banner strip with the avatar overlapping its lower edge. The avatar element is
 * passed in because its SOURCE differs per card (own /api/avatar/me vs the chat
 * message's platform avatar); the strip, the gradient and the overlap offset are
 * identical.
 *
 * One control slot: `topRight` sits ON the banner and is for actions aimed at the
 * PERSON (Message, Gift on the public card).
 *
 * Edit is NOT here: over the banner it would cover the image the user just
 * uploaded, and next to the pfp it would read as an avatar control. It sits
 * beside the NAME in ProfileCardBody, which is the thing it edits.
 *
 * When the user uploaded a banner (site.users.banner_mxc) it renders over
 * the gradient via the authenticated media proxy — the gradient stays underneath
 * as the loading/failure fallback. mxcToScaled (a scale THUMBNAIL, not the
 * download) on purpose: the full upload can be a 24 MP phone photo, and
 * decoding it during the card's entry starves raster — the panel's background
 * would arrive in chunks with no animation. A GIF banner therefore freezes to
 * its first frame. Synapse refuses to thumbnail an image over its
 * max_image_pixels (32 MP), so onError swaps to the download once and hides on
 * a second failure — never a broken icon.
 *
 * Overlap geometry: the avatar sits in its own POSITIONED wrapper placed after
 * the banner in the DOM. The banner div is positioned (it anchors `topRight`),
 * so a static avatar wrapper pulled up with a negative margin would paint BELOW
 * it — hiding the avatar's top half behind the banner. Positioned vs positioned
 * paints in DOM order, so the avatar wins. The `h-6` flow strip
 * reserves exactly the avatar's below-banner overhang (64px avatar − 40px over
 * the banner): top two-thirds over the banner, bottom third below its edge.
 */
export function CardBanner({
  displayName, avatar, topRight, bannerMxc,
}: {
  displayName: string;
  avatar: ReactNode;
  /** Control painted ON the banner, top-right. Actions aimed at the person. */
  topRight?: ReactNode;
  /** mxc:// URL of the uploaded banner image, if any. */
  bannerMxc?: string | null;
}) {
  const bannerUrl = mxcToScaled(bannerMxc);
  return (
    <>
      <div className="relative h-20 bg-surface-3 overflow-hidden" style={{ background: bannerGradient(displayName) }}>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover object-center"
            onError={e => onScaledError(e.currentTarget, bannerMxc)}
          />
        )}
        {topRight && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5">{topRight}</div>
        )}
      </div>
      <div className="relative h-6">
        <div className="absolute left-4 bottom-0">{avatar}</div>
      </div>
    </>
  );
}

/**
 * The username exactly as chat renders it: custom color + equipped style
 * (gradient/glow), the equipped badges, at the reader's own chat size and
 * username font. Both cards feed it the same shapes — the own card from
 * /api/me/{color,style}, the public card from the chat message's own
 * usernameColor/usernameStyle.
 *
 * THIS IS THE ONE PLACE THAT ANSWERS "what will my name look like" — before
 * saving, and before buying a style. It must match chat in every respect, or a
 * style bought from the preview looks different in chat:
 *   • size: the reader's own --chat-font-size and --chat-badge-scale;
 *   • badges in FRONT of the name, as in ChatMessage;
 *   • --chat-username-font / --chat-username-weight.
 * Every preview surface must come through here rather than re-deriving it —
 * re-derived previews drift from chat.
 */
export function StyledName({
  name, color, style, badges, fit, replay,
}: {
  name: string;
  color: string;
  style: EquippedStyle | null;
  badges: BadgeDef[];
  /** Shrink to fit the parent's width instead of wrapping or being clipped,
   *  and enlarge up to this zoom when there is room (1 = never enlarge). */
  fit?: number;
  /** Replay an equipped entrance every few seconds (the pickers — an entrance
   *  preview should show the animation). Elsewhere it plays once. */
  replay?: boolean;
}) {
  const inkRef = useNameInk(style?.font, name);
  const replayRef = useEntranceReplay(!!replay && !!style?.entrance);
  const inkAndReplayRef = useCallback((el: HTMLSpanElement | null) => { inkRef(el); replayRef.current = el; }, [inkRef, replayRef]);
  // Paused only while off screen.
  const nameRef = useAnimFenceRef(usernameStyleAnimClass(style) !== "", inkAndReplayRef);
  const boxRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = boxRef.current, host = el?.parentElement;
    if (!fit || !el || !host) return;
    let last = "";
    const run = () => {
      const cs = getComputedStyle(host);
      const avail = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const prev = el.style.zoom;
      el.style.zoom = "1";
      const need = el.scrollWidth;
      // Guarded, because setting the zoom resizes `el`, which is observed too.
      const key = `${avail}:${need}`;
      if (key === last) { el.style.zoom = prev; return; }
      last = key;
      // Still too wide at the floor, a centred host must lose the END, not
      // both ends — the hosts centre with `justify-center-safe` for that.
      el.style.zoom = String(fitZoom(need, avail, fit));
    };
    run();
    // Widths change when the box resizes, when the face finishes loading, and
    // when the name's own measured side room (nameInk.ts) lands on it.
    const ro = new ResizeObserver(run);
    ro.observe(host);
    ro.observe(el);
    const refit = () => { last = ""; run(); };
    document.fonts?.addEventListener("loadingdone", refit);
    return () => { ro.disconnect(); document.fonts?.removeEventListener("loadingdone", refit); };
  }, [fit, name, style, badges.length]);
  return (
    <div
      ref={boxRef}
      // `shrink-0` in fit mode: as a flex item the row would otherwise be
      // squeezed to its box, and the first thing to give is the badge image
      // (measured: squeezed to 0px in a store tile). The zoom does the fitting.
      className={fit ? "inline-flex items-center flex-nowrap whitespace-nowrap shrink-0" : "flex items-center flex-wrap"}
      // Same gap chat puts between the badges and the name, so a preview with
      // badges is spaced like the row it is predicting.
      style={{
        gap: "var(--chat-pi-gap, 11px)",
        fontSize: CHAT_FONT,
        // The reader's chat SHADOW. `.chat-msg-row` sets
        // `text-shadow: var(--chat-shadow)` in globals.css; without it here,
        // with the shadow on, every preview would understate the weight of the
        // face it previews — worst on the heavy display faces (Bowlby One,
        // Bungee). Inherited by the name span; an effect that sets its own
        // textShadow already appends CHAT_SHADOW rather than replacing it, so
        // glow/emboss are unaffected.
        textShadow: "var(--chat-shadow)",
      }}
    >
      {badges.length > 0 && (
        <span
          className="inline-flex items-center shrink-0"
          // Badges take the shadow as a drop-shadow FILTER, not text-shadow —
          // they are images. Same pairing as `.chat-msg-body .chat-badges`.
          style={{ gap: "var(--chat-badge-gap)", filter: "var(--chat-shadow-filter)" }}
        >
          {badges.map((b) => (
            <img
              key={b.id} src={b.imageUrl} alt={b.name} title={b.name}
              className="w-auto rounded-sm"
              // Same formula as chat's badge row — frozen basis, NOT the text
              // size (the preview must track what chat actually renders).
              style={{ height: rowBasisCalc("1.10 * var(--chat-badge-scale, 1)") }}
            />
          ))}
        </span>
      )}
      <span
        ref={nameRef}
        className={usernameStyleAnimClass(style)}
        style={{
          color,
          fontFamily: "var(--chat-username-font, inherit)",
          fontWeight: "var(--chat-username-weight, 600)" as CSSProperties["fontWeight"],
          // The reader's Username Text size, exactly as ChatMessage applies it
          // — this preview answers "what will my name look like".
          fontSize: CHAT_FONT,
          filter: "saturate(var(--chat-username-sat, 1))",
          ...usernameStyleCSS(style, color),
        }}
      >
        {name}
      </span>
    </div>
  );
}

/** A small labelled stat pill (Credit · Msgs · Streams …). */
export function Pill({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-2 text-2xs text-body-dim whitespace-nowrap">
      {label && <span className="text-muted">{label}</span>}
      {children}
    </span>
  );
}
