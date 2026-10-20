// The video panel's sizing class. The MODE class (a fallback's own / fill / attached)
// stays while folded and player-folded is ADDED: swapping one for the other
// makes the box drop its mode sizing — the radio's content-fit height becomes
// the base 16:9 box — in the same frame the fold begins, so a partly open panel
// grows to full and then folds (measured 254 → 1061 → 38px).
// `.bb-panel.player-folded` (globals.css, unlayered) still wins `flex: none`
// over the fill mode's md:flex-1 utility.
// A registered fallback brings its own sizing class — `fallbackClass`, null otherwise.
export function playerPanelClass({ folded, fallbackClass, fillMode }: { folded: boolean; fallbackClass: string | null; fillMode: boolean }): string {
  const mode = fallbackClass ?? (fillMode ? "player-fill md:flex-1 md:min-h-0" : "player-attached");
  return folded ? `${mode} player-folded` : mode;
}
