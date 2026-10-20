// The mod panel's visual grammar — one place so its cards can't drift apart. Here, not inside
// app/features/moderation/, because a plugin's Admin Panel places (app/lib/plugins/admin.ts) use it too
// and may not reach past a feature's index (check-structure rule 3). The moderation feature's
// sections read it through their own shared.ts.

export const card = "rounded-xl border border-edge bg-surface-1 p-4";
export const h2 = "text-sm font-semibold text-body mb-3";
export const input = "flex-1 min-w-0 rounded-lg border border-edge bg-surface-1 px-3 py-1.5 text-sm text-body placeholder:text-faint outline-none focus:border-edge-strong";
export const btn = "text-xs font-medium px-3 py-1.5 rounded-lg border border-edge bg-surface-1 hover:bg-surface-2 text-body transition-colors disabled:opacity-40";

export function timeAgo(t: string | number): string {
  const ms = Date.now() - new Date(t).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
