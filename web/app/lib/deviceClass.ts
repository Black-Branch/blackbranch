import { Q_DEVICE_MOBILE } from "./deviceQueries.ts";

// Device-class for settings sync: phones/tablets are one class, everything else
// desktop. Coarse pointer + narrow viewport ≈ handheld; a touch laptop stays
// desktop (fine pointer present). SSR → desktop (hydration re-reads).
//
// This breakpoint is about which SETTINGS BLOB an account syncs and how big
// the paint budget is — a genuinely different question from "is there room for
// two columns", which is Q_NARROW. The two DISAGREE between 768px and 1024px on
// a coarse pointer, deliberately; see deviceQueries.ts.
//
// The NAME and the two return strings are a data contract, not an
// implementation detail: the value is persisted as `site.user_settings
// .device_class` and sent as an API query param (app/api/me/settings/route.ts).
// Changing either is a migration, not a refactor.
export function deviceClass(): "desktop" | "mobile" {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  return window.matchMedia(Q_DEVICE_MOBILE).matches ? "mobile" : "desktop";
}
