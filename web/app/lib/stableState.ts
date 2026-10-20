// Functional-updater guard for pollers: keep the PREVIOUS state object when the
// incoming payload is structurally identical, so a poll that returns the same
// data doesn't mint a fresh identity. Fresh identities are how a 60s badge
// poll re-renders every mounted chat row past its memo: setState(newObject) →
// context value changes → memo can't help. With this guard React bails out
// (Object.is(prev, prev)) and nothing renders.
//
// JSON.stringify comparison is deliberate: the guarded payloads are small,
// JSON-shaped API responses on ≥30s cadences, where a full compare per poll is
// noise next to the render storm it prevents. Not for hot paths.
export const keepIfEqual = <T,>(next: T) => (prev: T): T =>
  JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
