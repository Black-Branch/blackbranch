import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// OBS browser-source pages: no site chrome (this sits OUTSIDE app/(main), like
// /popout), and a transparent canvas — the root layout paints html/body with
// the theme background, which would otherwise show as a solid slab over the
// scene. The root layout's providers (BadgesProvider, SponsorClockProvider,
// fonts) still wrap this, which is the whole point: an overlay served from the
// web app renders names with chat's real style engine, not a copy of it.
// Scrollbars are hidden too: the chat overlay scrolls inside its own box, and a
// browser source draws that box's scrollbar as an opaque strip over the scene.
export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`html, body { background: transparent !important; overflow: hidden; }
* { scrollbar-width: none; }
::-webkit-scrollbar { display: none; }`}</style>
      <div className="relative h-full w-full">{children}</div>
    </>
  );
}
