"use client";

import type { CSSProperties, ReactNode } from "react";
import { AVATAR_PX, avatarStyle, type AvatarStep } from "@/app/lib/avatarSize";
import { avatarBg } from "@/app/lib/avatarColor";
import { mxcToHttp } from "@/app/lib/matrixMedia";
import { useImgFallback } from "@/app/lib/useImgFallback";

/**
 * The coloured letter circle a missing or failed picture shows (Discord's) — the ONE rendering
 * of it. The caller sizes and weights it (`className`/`style`); the circle, the centring, the
 * colour (`avatarBg` of the name unless `bg` is given) and the letter are this. `wrapLetter`
 * nests the letter in its own element, for a caller whose box is sized in em of its own font.
 */
export function LetterCircle({
  name,
  className = "",
  style,
  bg,
  wrapLetter,
}: {
  name: string;
  className?: string;
  style?: CSSProperties;
  bg?: string;
  wrapLetter?: (letter: string) => ReactNode;
}) {
  const letter = name.slice(0, 1).toUpperCase();
  return (
    <span
      data-letter-circle=""
      className={`rounded-full shrink-0 flex items-center justify-center select-none ${className}`}
      style={{ backgroundColor: bg ?? avatarBg(name), ...style }}
    >
      {wrapLetter ? wrapLetter(letter) : letter}
    </span>
  );
}

// The Matrix avatar-with-fallback-initial, sized by the ONE avatar scale (app/lib/avatarSize.ts;
// the `--avatar-*` tokens and the `.avatar` box in globals.css). `size` names a step; `scaled` is
// for a picture IN a chat row, which alone answers to the Avatar-size slider. The composer's own
// button (UserMenu) and the send-to bot (SendToButton) are controls sized with their row, not
// pictures on the scale; they share `LetterCircle` only.
export function Avatar({
  mxcUrl,
  name,
  size = "md",
  scaled = false,
  box,
  thumb = AVATAR_PX[size],
}: {
  mxcUrl?: string | null;
  name: string;
  size?: AvatarStep;
  /** × the Chat rows › Avatar-size slider (a chat row's picture only). */
  scaled?: boolean;
  /** A custom property that, when the stylesheet sets it, IS the size (the Community row's
   *  Cozy gutter, `--mx-avatar-box`); unset, the step. */
  box?: string;
  /** The px the thumbnail must cover (fetched at 2x); defaults to the step's. */
  thumb?: number;
}) {
  const httpUrl = mxcToHttp(mxcUrl, thumb * 2);
  const { ok: imgOk, ref: imgRef, onError: onImgError } = useImgFallback(httpUrl);
  const style = avatarStyle(size, scaled, box);

  if (httpUrl && imgOk) {
    return <img src={httpUrl} alt={name} ref={imgRef} onError={onImgError} className="avatar img-shadow-chat" style={style} />;
  }
  return <LetterCircle name={name} className="avatar text-strong font-semibold img-shadow-chat" style={{ ...style, fontSize: "calc(var(--avatar-box) * 0.44)" }} />;
}
