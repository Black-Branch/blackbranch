// A chat scroller that arrives with its rows already in the HTML (the
// server-seeded history, chatSeed.ts) would show its OLDEST rows first: a
// scroll container starts at the top, and the engine's bottom lock
// (useAnchoredChat) only runs once React has hydrated. This inline script runs
// while the HTML is still being parsed — placed IMMEDIATELY after the scroller
// it targets, it finds it as its previous element sibling and snaps it to the
// bottom before the first paint. The same device as the settings prepaint in
// app/layout.tsx (the CSP allows inline scripts for it).
//
// Hydration keeps the element (React does not re-run a script it hydrates),
// and the engine takes over from there. On a pane that is hidden at parse time
// (a phone's inactive chat tab) scrollHeight is 0 and this is a no-op.

const SNAP = "(function(){var s=document.currentScript,e=s&&s.previousElementSibling;if(e)e.scrollTop=e.scrollHeight;})()";

export function ScrollBottomBeforeHydration() {
  return <script dangerouslySetInnerHTML={{ __html: SNAP }} />;
}
