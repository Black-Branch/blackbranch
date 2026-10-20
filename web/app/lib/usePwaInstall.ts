"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useClientValue } from "@/app/lib/useClientState";

// PWA install state. Captures the deferred `beforeinstallprompt` event and
// exposes a one-tap install plus the flags the UI needs to decide what to show
// (Android prompt vs. iOS manual steps vs. already-installed).
//
// The service worker that makes the site installable is registered separately by
// `ServiceWorkerRegistrar` in the root layout — this hook mounts on only two
// routes, which is not enough coverage for it.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ masquerades as a Mac; a touch-capable "Mac" is really an iPad.
  const iPadOS = ua.includes("Macintosh") && typeof document !== "undefined" && "ontouchend" in document;
  return iOS || iPadOS;
}

// display-mode flips when the site is opened as an installed app; subscribing
// keeps `isStandalone` live instead of snapshotting it once on mount.
function subscribeStandalone(cb: () => void) {
  const mq = window.matchMedia?.("(display-mode: standalone)");
  mq?.addEventListener?.("change", cb);
  return () => mq?.removeEventListener?.("change", cb);
}

export function usePwaInstall() {
  const [canInstall, setCanInstall] = useState(false);
  // Set from the `appinstalled` event: freshly installed counts as standalone
  // for the UI (hides the nudge) even though this tab still runs in-browser.
  const [justInstalled, setJustInstalled] = useState(false);
  const standaloneNow = useSyncExternalStore(subscribeStandalone, detectStandalone, () => false);
  const isStandalone = standaloneNow || justInstalled;
  const isIos = useClientValue(detectIos, false);
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // NOTE: the service worker is NOT registered here. Registration lives in
    // `ServiceWorkerRegistrar`, mounted from the root layout, because this hook
    // only mounts on a couple of routes — see that file.

    function onBeforeInstall(e: Event) {
      e.preventDefault();
      deferredRef.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    }
    function onInstalled() {
      deferredRef.current = null;
      setCanInstall(false);
      setJustInstalled(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    const e = deferredRef.current;
    if (!e) return false;
    await e.prompt();
    const choice = await e.userChoice.catch(() => null);
    deferredRef.current = null;
    setCanInstall(false);
    return choice?.outcome === "accepted";
  }, []);

  return { canInstall, promptInstall, isStandalone, isIos };
}
