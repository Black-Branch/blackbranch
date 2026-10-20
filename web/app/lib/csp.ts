// The site's Content-Security-Policy — ONE writer for both places that send it.
//
// The policy names this install's own origins (its API, its socket, its homeserver), which are
// install values read when the server starts — so it cannot be fixed at build:
//   • proxy.ts sends it, with this install's origins, on every page and API response;
//   • next.config.ts sends it WITHOUT them on what the proxy never sees (the build's static files,
//     public files, the service worker), where there is no <audio> element and the scheme-wide
//     https:/wss: already cover an https install's calls.
// Both come from the one function below, so the two can only differ by the origins.

export type CspOrigins = { api?: string; ws?: string; matrix?: string };

export function contentSecurityPolicy(o: CspOrigins = {}): string {
  // Each origin with its leading space, or nothing ("" when an origin is not known, as on files).
  const api = o.api ? ` ${o.api}` : "";
  const own = [o.api, o.ws, o.matrix].filter(Boolean).map((x) => ` ${x}`).join("");
  return [
  "default-src 'self'",
  // 'unsafe-inline' required for Next.js inline bootstrap/hydration scripts.
  // 'wasm-unsafe-eval' required for matrix-js-sdk Rust crypto WASM.
  // js.stripe.com / checkout.stripe.com host Stripe.js + Embedded Checkout.
  // www.paypal.com / www.paypalobjects.com host the PayPal Buttons SDK
  // — without these the SDK's <script> tag is silently blocked and the PayPal
  // button just never appears.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://static.cloudflareinsights.com https://js.stripe.com https://checkout.stripe.com https://www.youtube.com https://embed.twitch.tv https://www.paypal.com https://www.paypalobjects.com",
  // Tailwind injects inline styles at runtime; unsafe-inline is needed.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  // media elements are governed by media-src (not connect-src), so it must be
  // listed here too.
  // · the API origin (install key site.apiOrigin) serves the radio audio and the rig page's clips
  //   to the <audio> element.
  // · stream.place is the in-house player's COMPATIBILITY (HLS) path: Safari/iOS
  //   sets video.src straight to the playlist, and without this origin the
  //   browser refuses it with "Media load rejected by URL safety check". hls.js's
  //   MSE path feeds a blob: URL and is already covered — which is why this was
  //   invisible in Firefox and broken everywhere else.
  // · BOTH the apex and *.stream.place, and neither covers the other. media-src
  //   governs every load the element makes, not just the manifest: on the native
  //   path the element fetches each SEGMENT itself, and a redirect to a playback
  //   node is a media load too. stream.place's playback nodes are subdomains by
  //   design — app/lib/whepProxy.ts already grants exactly this trust boundary
  //   (`h === "stream.place" || h.endsWith(".stream.place")`) when it accepts a
  //   discovered playback server. The apex stays because the playlist URL itself
  //   is on it (and a CSP host wildcard does not match the bare host).
  `media-src 'self' blob:${api} https://stream.place https://*.stream.place`,
  // Scheme-wide, NOT a host allowlist: federated Matrix login means the embedded
  // matrix-js-sdk client syncs directly against the user's OWN homeserver (any
  // domain, further redirected by .well-known), so the hosts cannot be enumerated —
  // an allowlist here silently breaks the Matrix panel for every external-homeserver
  // account. Exfiltration-wise this concedes nothing img-src's `https:` doesn't
  // already allow.
  // The install's own API, socket and homeserver origins are named too: on an https install
  // they are already covered, but an install served over plain http (a local or test one)
  // would otherwise have every chat socket and Matrix call refused.
  `connect-src 'self' https: wss:${own}`,
  "font-src 'self'",
  // Stripe Embedded Checkout mounts iframes from js.stripe.com / checkout.stripe.com
  // (hooks.stripe.com handles 3-D Secure challenges).
  // The PayPal Buttons SDK renders its button in a www.paypal.com iframe
  // (live) or www.sandbox.paypal.com (sandbox credentials — the only
  // environment it can be verified in, so both hosts are required or the
  // button is invisible under test).
  "frame-src https://stream.place https://www.youtube.com https://player.twitch.tv https://js.stripe.com https://checkout.stripe.com https://hooks.stripe.com https://www.paypal.com https://www.sandbox.paypal.com",
  "object-src 'none'",
  // No form on the site posts anywhere but here (every one is handled in script; Stripe and PayPal
  // run their own forms inside their own frames), so an injected <form> cannot send a viewer's
  // input to another origin. default-src does not cover form-action.
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");
}
