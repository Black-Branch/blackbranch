"use client";

import { useEffect } from "react";
import {
  SETTING_KEYS, readValues, applyEffect, type ApplyCtx,
} from "../lib/settingsRegistry";
import { lsGet, lsSet } from "../lib/safeLocalStorage";
import { postJson } from "../lib/http";
import { useViewportHeightVar } from "../lib/useViewportHeightVar";
import { pullAccountSettings } from "../lib/accountSettings";

// Page-load settings hydrator. The pre-paint script in layout.tsx applies this
// device's localStorage before first paint, but cross-device settings (stored in
// the DB) only landed when the ChatSettings panel was opened — so a second device
// looked default until you opened settings. This top-level component closes that
// gap: on load it pulls the DB blob into localStorage and re-applies every CSS
// var / html class, then notifies the React consumers of the two non-CSS toggles
// (timestamps, Matrix username) via a `bb:settings-hydrated` event.
//
// It never writes back to the DB (only ChatSettings saves), so there's no write
// amplification; running again when ChatSettings later mounts is idempotent.
export default function SettingsHydrator() {
  // Keeps the shell height on <html>/<body> in step with the on-screen keyboard. Mounted here
  // because this component is already the single always-present client node
  // under <body> — the hook itself is a no-op on anything but a touch phone.
  useViewportHeightVar();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // pullAccountSettings() owns the overlay guard (the "ov:" scope, /chat +
      // /overlay/chat, is device-local by design: it never pulls the account's
      // DB blob) and the v1→v2 conversion of both local keyspaces + the blob.
      const { authed } = await pullAccountSettings();
      if (authed) captureTimezone();
      if (cancelled) return;
      const fresh = readValues();
      const ctx: ApplyCtx = { get: (k) => fresh[k] };
      for (const key of SETTING_KEYS) applyEffect(key, fresh[key], ctx);
      window.dispatchEvent(new Event("bb:settings-hydrated"));
    })();
    return () => { cancelled = true; };
  }, []);

  return null;
}

// Silently capture this browser's timezone so the bot knows a user's real local time
// (accurate "their clock" instead of assuming the streamer's). Called only when the
// settings fetch confirms the user is signed in, and only sends when the tz changed
// since last time — no write amplification, no anonymous requests. Stored on the
// canonical identity by stream-api.
function captureTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    if (lsGet("bb_tz_sent") === tz) return;
    postJson("/api/me/timezone", { timezone: tz }, "PATCH")
      .then((r) => { if (r.ok) lsSet("bb_tz_sent", tz); })
      .catch(() => {});
  } catch { /* no Intl / blocked — skip */ }
}
