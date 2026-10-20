// Pure state rules for the bottom dock — the tabbed area under the video.
// The user's choice and the available space are ORTHOGONAL, and conflating
// them is the bug to avoid: faded (no room for even the tab row) is a space
// outcome, collapsed (tab row only, content unmounted) is a user choice.
//
// Tab KEYS are the shared registry's (tabRegistry.ts) — this module owns only
// the dock's open/collapsed/space rules. A local `DockTabKey = string` would
// cost casts at the call sites, each one a place the compiler stops checking
// a tab key.
//
// `.ts` extension required: node --test loads this module directly, and its
// resolver does no extension inference (app/lib/testDom.ts says why).
import { isSiteTabKey, type SiteTabKey } from "./tabRegistry.ts";

/**
 * The tab an unconfigured (or invalidly-configured) dock opens on — Home, the
 * front door.
 *
 * @test-only readDockTab, in this file, is its only runtime reader — the dock
 * does not import it (its Sections strip simply selects nothing while
 * collapsed). dockState.test.ts pins the value.
 */
export const DOCK_DEFAULT_TAB: SiteTabKey = "home";

/**
 * Stored `dock_tab` value → the open tab, or `null` for collapsed.
 * `""` is collapsed and is a VALID stored choice, distinct from nothing
 * stored. An unknown key falls back to the default, not to collapsed —
 * otherwise removing a tab in a future release silently collapses the dock
 * for everyone who had that tab open.
 */
export function readDockTab(raw: string | null, known: readonly SiteTabKey[]): SiteTabKey | null {
  if (raw === "") return null;
  if (isSiteTabKey(raw) && known.includes(raw)) return raw;
  return DOCK_DEFAULT_TAB;
}

/** The open tab (or `null` for collapsed) → the string to persist. */
export function writeDockTab(tab: SiteTabKey | null): string {
  return tab ?? "";
}

/** Does the tab row alone fit? (The collapsed dock is exactly the row.) */
// @test-only dockState.test.ts pins the tab-row height boundary.
export function dockVisible(leftoverPx: number, tabRowPx: number): boolean {
  return leftoverPx >= tabRowPx;
}

/**
 * Whole-dock visibility. OPEN: the dock shows only while its content can —
 * the tabs fade WITH the content (a tab row you can't open anything under is
 * noise; the space rule already hides the content).
 * COLLAPSED: the row alone is the dock, so only the row has to fit.
 * Uses just the hidden/not-hidden edge of viewForHeight — the shared 30px
 * content floor — not News's ticker/list split.
 */
export function dockShown(
  openTab: SiteTabKey | null,
  leftoverPx: number,
  tabRowPx: number,
  contentHidden: boolean,
): boolean {
  if (openTab === null) return dockVisible(leftoverPx, tabRowPx);
  return !contentHidden;
}

/**
 * The height the open tab's content may use (never negative). What a tab does
 * with it is the tab's business — News maps it through `viewForHeight`
 * (unchanged, constants keep their exact meaning), VODs just scrolls.
 */
export function contentAvail(leftoverPx: number, tabRowPx: number): number {
  return Math.max(0, leftoverPx - tabRowPx);
}
