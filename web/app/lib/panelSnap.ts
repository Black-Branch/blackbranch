// The magnetic zones of the chat-column drag, pure so a test can say what a
// raw width arms. Dragging the chat shut folds the CHAT, not theatre mode:
// theatre also overlays the video bars and removes the dock — three changes
// for a gesture that asks for one.
export type SnapZone = "chatFolded" | "full";
// @test-only exported so panelSnap.test.ts can state each boundary in terms of
// the constant (THEATRE_ZONE - 1 arms, THEATRE_ZONE does not) instead of
// re-typing 150 and drifting from it. snapZoneFor is the only runtime reader;
// no caller should compare a width to these itself.
export const THEATRE_ZONE = 150;  // raw drag width below this arms the chat fold
// @test-only same reason as THEATRE_ZONE above: the test names the
// viewport-edge boundary by the constant rather than duplicating 140.
export const FULL_MARGIN = 140;   // raw drag width within this of the viewport arms full-screen

export function snapZoneFor(raw: number, innerWidth: number): SnapZone | null {
  if (raw < THEATRE_ZONE) return "chatFolded";
  if (raw > innerWidth - FULL_MARGIN) return "full";
  return null;
}
