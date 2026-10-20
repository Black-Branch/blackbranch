// Shared helpers for the mod-panel sections. The visual grammar (card, h2, input, btn, timeAgo)
// lives in app/components/modPanelKit.ts, which a plugin's mod-panel tabs share; re-exported
// here so the sections keep one import.

export { card, h2, input, btn, timeAgo } from "@/app/components/modPanelKit";

export function shortName(matrixId: string, display?: string | null): string {
  if (display) return display;
  const m = /^@([^:]+):/.exec(matrixId);
  return m?.[1] ?? matrixId;
}

export function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expiring";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m left`;
  return `${Math.floor(hours / 24)}d left`;
}

// One resolution rule with the /command palette — the two copies had drifted
// (this one mangled an un-prefixed full id). Logic + caveats: app/lib/modTarget.ts.
export { resolveModTarget as resolveTarget } from "@/app/lib/modTarget";
