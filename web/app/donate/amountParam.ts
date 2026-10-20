// ?amount=10 preselects an amount on the tip page. A link someone pasted is not
// a form submission: anything unusable is ignored and the page shows its normal
// default, rather than rendering an error at a person who just wanted to tip.
const MIN = 1;
const MAX = 1000;

export function parseAmountParam(raw: string | string[] | undefined): number | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string" || first.trim() === "") return undefined;
  const n = Number(first);
  if (!Number.isFinite(n)) return undefined;
  if (n < MIN || n > MAX) return undefined;
  return n;
}
