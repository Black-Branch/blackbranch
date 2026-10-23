// Forwarding help-desk tickets to the Black Branch project: the SEAM the Admin Panel's Support
// tickets page is built against. SERVER ONLY.
//
// There is no transport yet: the project has no address that takes tickets, and the site keeps no
// record of what it sent. Until both exist, `forwarding()` says so and `forwardTickets()` sends
// nothing, so the page shows its switch and buttons switched off with one line saying why, rather
// than a switch that does nothing. Building it means: an address on blackbranch.app that takes a
// ticket, an instance switch (off by default), a sent-at record per ticket, and the same scrub the
// doctor's report uses (no secret, no viewer id, no domain).

export type ForwardState = {
  /** Whether this release can send tickets at all. */
  available: boolean;
  /** The switch: forward new tickets as they arrive. */
  on: boolean;
  /** Tickets already sent (Send all skips them). */
  sent: number[];
};

/** What the page shows. */
export function forwarding(): ForwardState {
  return { available: false, on: false, sent: [] };
}

/** Send these tickets, skipping any already sent. → which were sent, which skipped, or why none. */
export async function forwardTickets(ids: readonly number[]): Promise<{ ok: true; sent: number[]; skipped: number[] } | { ok: false; error: string }> {
  const state = forwarding();
  if (!state.available) return { ok: false, error: "Forwarding tickets to Black Branch arrives in a later release." };
  const skipped = ids.filter((id) => state.sent.includes(id));
  return { ok: true, sent: ids.filter((id) => !skipped.includes(id)), skipped };
}
