// Which of the doctor's rows the Admin Panel lists. Pure.
//
// The two checks about an older install's leftovers (an old platform id, an old Matrix prefix) are
// listed only once their value is set, or when they warn or fail. A fresh install never sets them,
// and two "not needed" rows read as two things to understand. The command (`blackbranch doctor`)
// prints every row; this is the page's choice only.

const ONLY_WHEN_SET = ["site.legacyId", "matrix.namespace"];

/** The rows the page lists, in the doctor's order. */
export function shownRows<R extends { id: string; status: string; detail: string }>(rows: readonly R[]): R[] {
  return rows.filter((r) => !ONLY_WHEN_SET.includes(r.id) || r.status === "fail" || r.status === "warn" || /^set\b/.test(r.detail));
}
