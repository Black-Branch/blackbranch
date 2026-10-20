export function formatMoney(cents: number, currency: string): string {
  const v = cents / 100;
  const cur = (currency || "usd").toLowerCase();
  if (cur === "usd") return `$${v.toFixed(2)}`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase() }).format(v);
  } catch {
    return `${v.toFixed(2)} ${cur.toUpperCase()}`;
  }
}

// "alice" / "alice and bob" / "a, b, and c" / "a, b, … and N more" (cap the list
// so a big community gift doesn't flood the row).
export function formatNameList(names: string[], cap = 8): string {
  if (names.length === 0) return "the community";
  if (names.length === 1) return names[0] ?? "the community";
  const shown = names.length <= cap ? names : names.slice(0, cap);
  const last = shown[shown.length - 1] ?? "";
  const head = shown.slice(0, -1).join(", ");
  const base = `${head}, and ${last}`;
  if (names.length <= cap) return base;
  return `${shown.join(", ")}, and ${names.length - cap} more`;
}

// "+7m 6s" style compact duration for the time a contribution added to the
// timer. (Named distinctly from vods.ts's ISO-8601 fmtDuration — different
// input type and purpose.)
export function formatChipDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}
