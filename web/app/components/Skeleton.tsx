// Shared skeleton primitives for perceived performance (audit EP-4). A skeleton
// reserves the *shape* of content that is still loading so async panels and
// route transitions resolve into place instead of popping spinner→content.
// Prefer these over a bare `Spinner` for known-shape waits (panel bodies).
// Never as a route `loading.tsx` in front of a server-side sign-in or role
// redirect: the loading boundary starts the response streaming, so the redirect
// arrives after the skeleton has already painted (panelGateRedirect.test.ts).
// The shimmer lives on the `.skeleton` class in globals.css and is gated by prefers-reduced-motion down to a static block — keep it there, not
// inline, so the reduced-motion contract holds. All pieces are decorative
// (`aria-hidden`); announce the wait once on the wrapper via `role="status"`.

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block rounded-md ${className}`} />;
}
