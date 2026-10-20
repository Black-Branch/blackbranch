"use client";

import { useEffect } from "react";

// Registers `public/sw.js` on EVERY route.
//
// This used to live inside `usePwaInstall()`, which meant the worker only
// registered where that hook mounted — the handful of route-scoped nudges in
// `app/(main)/layout.tsx`. So `/chat`, `/popout`, `/about`, `/legal`
// and `/billing` ran with no service worker at all: no emote cache, and no
// `navigate` fetch handler, which is what Chromium requires before it will fire
// `beforeinstallprompt`. A visitor whose first stop was `/chat` was never offered
// the install, and the emote cache started cold.
//
// Mounted from the ROOT layout so coverage can't silently regress to a subtree
// again. Renders nothing.
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // updateViaCache:"none" makes the browser bypass its HTTP cache for sw.js on
    // every update check. Belt and braces on top of the origin's max-age=0: a
    // CDN can rewrite that header at the edge (Cloudflare's zone-wide Browser
    // Cache TTL turns it into max-age=14400), so the origin header alone may not
    // survive to the browser. This flag is decided client-side and cannot be
    // overridden by any CDN.
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  }, []);

  return null;
}
