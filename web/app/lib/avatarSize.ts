import type { CSSProperties } from "react";

// The ONE avatar scale. Every picture of a person or a room takes a step by name; the sizes are
// the `--avatar-*` tokens in globals.css (the `.avatar` class draws the box from them, snapped to
// whole pixels). Only a picture IN a chat row is × the Chat rows › Avatar-size slider
// (`scaled`) — the slider belongs to chat rows, not to lists, cards or the rail.
//
//   xs   16  Compact's head picture (× the slider)
//   sm   24  beside one line of text: thread chip, forum byline, thread list, room chips,
//            the DM window's band, the community chooser
//   md   32  a list row: the DM list and its invites, the member list; the player bar;
//            the narrow pane's message gutter (× the slider)
//   lg   40  the rail's tiles (your profile, DM chips); the wide pane's message gutter (× the slider)
//   xl   64  the profile cards and the member card
//   line     one chat line tall (the frozen row basis): the live chat row, Bubbles' head (× the slider)

/** The px each step draws at the default 16px root — the thumbnail a picture asks for. Restates
 *  globals.css (avatarSize.test.ts holds the two equal); `line` is the row basis, 21.632px. */
export const AVATAR_PX = { xs: 16, sm: 24, md: 32, lg: 40, xl: 64, line: 22 } as const;
export type AvatarStep = keyof typeof AVATAR_PX;

/** The CSS size of a step: its token, × the Avatar-size slider for a chat row's picture. */
export function avatarSize(step: AvatarStep, scaled = false): string {
  return scaled ? `calc(var(--avatar-${step}) * var(--chat-pfp-scale, 1))` : `var(--avatar-${step})`;
}

/** The style that sizes an `.avatar` element. `box` names a custom property that, when the
 *  stylesheet sets it, IS the size (the Community row's Cozy gutter, `--mx-avatar-box`). */
export function avatarStyle(step: AvatarStep, scaled = false, box?: string): CSSProperties {
  const size = avatarSize(step, scaled);
  return { ["--avatar-size" as string]: box ? `var(${box}, ${size})` : size };
}
