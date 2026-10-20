// Community settings: the
// per-row facts the Community timeline needs beyond grouping — which rows wear
// the alternating stripe, and where a message group ends (the bubbles layout
// rounds its last row). Pure; generic over anything with an id so node --test
// can drive it without the SDK.

// The stripe a row was first given, by event object. A WeakMap so a row keeps
// its stripe while it stays loaded and is forgotten with the event.
//
// Why not index parity: the live chat's own note (globals.css, `.alt-rows`) —
// position parity re-stripes the whole list whenever rows are added at the top
// (scroll-back paging) or the window slides at the bottom. Here each new row
// takes the opposite of the neighbour it arrived next to, so nothing already on
// screen ever changes colour.
const STRIPES = new WeakMap<object, boolean>();

/** true = this row wears the stripe. `rows` are in timeline order (oldest first). */
export function stripes<T extends object>(rows: readonly T[]): boolean[] {
  const out = rows.map((r) => STRIPES.get(r));
  let anchor = out.findIndex((v) => v !== undefined);
  if (anchor === -1) {
    if (rows.length === 0) return [];
    anchor = 0;
    out[0] = false;
    STRIPES.set(rows[0]!, false);
  }
  // Older rows (paged in above): opposite of the row below.
  for (let i = anchor - 1; i >= 0; i--) {
    if (out[i] === undefined) { out[i] = !out[i + 1]; STRIPES.set(rows[i]!, out[i]!); }
  }
  // Newer rows (arrived below): opposite of the row above.
  for (let i = anchor + 1; i < rows.length; i++) {
    if (out[i] === undefined) { out[i] = !out[i - 1]; STRIPES.set(rows[i]!, out[i]!); }
  }
  return out as boolean[];
}

/** true at i when row i is the LAST of its group: the next row starts a new one
 *  (or there is none). `continues(i)` = row i continues the group above it. */
export function groupEnds(count: number, continues: (i: number) => boolean): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(i === count - 1 || !continues(i + 1));
  return out;
}
