// The mods' Timeout lengths (spec 2026-10-23 §4.11: fixed durations, a reason required). One list
// for the member card and the route.

export const TIMEOUT_CHOICES = [
  { minutes: 1, label: "1 minute" },
  { minutes: 10, label: "10 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "1 day" },
  { minutes: 10080, label: "1 week" },
] as const;

export const TIMEOUT_REASON_MAX = 200;
