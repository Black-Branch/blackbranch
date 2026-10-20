"use client";

import { useState } from "react";
import nextDynamic from "next/dynamic";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { useClientValue } from "@/app/lib/useClientState";

// One-time prompt nudging a signed-in user to secure their account when encryption
// isn't set up / this device isn't verified. It educates (why it matters) and
// routes into the existing Devices & Security UI — it doesn't do any crypto itself.
// The outer component gates on dismissal + client-ready; the Inner half (which
// carries the heavy useMatrixSettings → crypto-api dependency) is a separate
// dynamic chunk so it never loads for dismissed/signed-out/idle sessions.

const Inner = nextDynamic(() => import("./SecureAccountPromptInner"), { ssr: false });

const DISMISSED_KEY = "bb_secure_dismissed";

export default function SecureAccountPrompt() {
  const { client, status } = useMatrixClient();
  // Hidden during SSR (true fallback), then driven by the stored flag.
  const lsDismissed = useClientValue(() => !!lsGet(DISMISSED_KEY), true);
  const [dismissedNow, setDismissedNow] = useState(false);
  const dismissed = lsDismissed || dismissedNow;

  if (dismissed || status !== "ready" || !client) return null;
  return <Inner onDismiss={() => { lsSet(DISMISSED_KEY, "1"); setDismissedNow(true); }} />;
}
