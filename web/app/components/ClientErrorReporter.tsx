"use client";

import { useEffect } from "react";
import { installGlobalErrorReporting } from "../lib/clientError";

// Installs the window-level error listeners for the whole app.
//
// Its own component rather than a few lines inside SettingsHydrator: that one is
// "hydrate settings", this is "never lose an error", and a settings change that
// early-returns (the overlay scope already does) would silently take error
// reporting down with it.
//
// Mounted in the ROOT layout, so it is present on the /chat window and the
// /overlay/* OBS sources too.
// That is deliberate — the overlay is the surface nobody is watching, which
// makes it the one where a silent failure lasts longest.
export default function ClientErrorReporter() {
  useEffect(() => installGlobalErrorReporting(), []);
  return null;
}
