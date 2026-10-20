import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowsIn, ArrowsOut, CaretUp, CaretDown } from "@phosphor-icons/react/dist/ssr";

/**
 * The chat panel's one "give this panel the screen" toggle: on desktop
 * `onToggleFull`/`isFull` drive the magnetic
 * full-screen community panel, but StreamView rebinds the same pair to the
 * player fold on a phone (`fullKind`) — so the button has to say which action
 * it is actually bound to, both on hover (title) and to assistive tech
 * (aria-label). ChatTabBar renders this control while the tab bar itself is
 * in flow; FoldedTabControl renders the SAME control in its floating pill
 * once the tab bar is folded away. One function, so the two cannot drift apart.
 */
export function fullToggleLabel(
  fullKind: "community" | "fold" | undefined,
  isFull: boolean | undefined,
): { label: string; Icon: PhosphorIcon } {
  const fold = fullKind === "fold";
  const label = fold
    ? (isFull ? "Unfold player" : "Fold player")
    : (isFull ? "Exit community mode" : "Community mode");
  const Icon = fold
    ? (isFull ? CaretDown : CaretUp)
    : (isFull ? ArrowsIn : ArrowsOut);
  return { label, Icon };
}
