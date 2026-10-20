// Chat timestamp formats (settings → Text → Timestamp format).
// Pure: node --test imports it. Explicit formats are built by hand so they read
// the same in every locale; "standard" keeps each place's own default look.
export const TS_FORMATS = ["standard", "24s", "24", "12", "12s", "rel"] as const;
export type TsFormat = (typeof TS_FORMATS)[number];
export type TsPlace = "live" | "community-header" | "community-hover";

const p2 = (n: number) => String(n).padStart(2, "0");

function clock(d: Date, fmt: Exclude<TsFormat, "standard" | "rel">): string {
  const h = d.getHours(), m = p2(d.getMinutes()), s = p2(d.getSeconds());
  if (fmt === "24s") return `${p2(h)}:${m}:${s}`;
  if (fmt === "24") return `${p2(h)}:${m}`;
  const h12 = h % 12 || 12, ap = h < 12 ? "AM" : "PM";
  return fmt === "12s" ? `${h12}:${m}:${s} ${ap}` : `${h12}:${m} ${ap}`;
}

function relative(d: Date, now: Date): string {
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function dayPrefix(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) return "Today at";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday at";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function formatChatTime(d: Date, fmt: TsFormat, place: TsPlace, now: Date = new Date()): string {
  if (fmt === "rel") return relative(d, now);
  if (fmt === "standard") {
    if (place === "live") return clock(d, "24s");
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return place === "community-header" ? `${dayPrefix(d, now)} ${t}` : t;
  }
  const t = clock(d, fmt);
  return place === "community-header" ? `${dayPrefix(d, now)} ${t}` : t;
}

// Indent-to-time pads wrapped lines past the timestamp column; each format has
// its own width. "standard"/"24s" keep the base value exactly. Mirrored in the
// layout.tsx pre-paint (a test pins the numbers).
const INDENT_CH: Record<TsFormat, string> = { standard: "6.5", "24s": "6.5", "24": "4.5", "12": "7.5", "12s": "10", rel: "7" };
export function tsIndentWidth(fmt: TsFormat): string {
  return `calc(${INDENT_CH[fmt] ?? "6.5"}ch + 0.25rem)`;
}
