// How long the BUNDLED homeserver keeps messages, as its generator configured it at its LAST render.
// A room without its own policy (every DM) keeps them as long as the cap that render used
// (community.retentionCapDays → install/matrix/render.sh's default policy; 0 = no limit, no default);
// #general keeps what its Community page row says once it has one (the community reconciler writes
// that row's days, capped, into the room); before that, the 30 days the bootstrap made it with
// (install/matrix/bootstrap.mjs), cut to the cap when the cap is shorter (the server's longest allowed). The host publishes the rendered cap as results/retention-cap.json
// (`blackbranch render`); a cap saved since then applies at the server's next start, so the page
// states what the server applies and says the saved change beside it. legalDocument.render.test.ts
// holds these to both files. An install whose homeserver is run elsewhere states none (no host fact).

/** Days a message is kept in #general, as the bootstrap makes it (until #general has a row). */
export const HOMESERVER_GENERAL_RETENTION_DAYS = 30;

export type HomeserverRetention = {
  /** Days a DM is kept; null = not deleted automatically (no cap). */
  dms: number | null;
  /** Days a message is kept in #general; null = not deleted automatically. */
  general: number | null;
  /** A saved cap the server has not taken yet (`dms` as above), or null. */
  pending: { dms: number | null } | null;
};

const dmsFor = (cap: number) => (cap > 0 ? cap : null);

/** #general's row as the privacy page reads it: its own days (null = as long as the server allows). */
export type GeneralRow = { retentionDays: number | null };

/** The days the community reconciler writes into a room for a row (reconcile-core retentionMs): with
 *  a cap, the row's days cut to it and no days = the cap; with none, the row's days or no limit. */
function rowDays(row: GeneralRow, capDays: number): number | null {
  if (capDays > 0) return row.retentionDays === null ? capDays : Math.min(row.retentionDays, capDays);
  return row.retentionDays;
}

/** What the privacy page states: the rendered cap, and the saved one when it differs; #general from
 *  its row when it has one (`general`), else the bootstrap's days. */
export function homeserverRetentionFor(renderedCapDays: number, savedCapDays: number, general: GeneralRow | null = null): HomeserverRetention {
  return {
    dms: dmsFor(renderedCapDays),
    general: general ? rowDays(general, savedCapDays)
      : renderedCapDays > 0 ? Math.min(HOMESERVER_GENERAL_RETENTION_DAYS, renderedCapDays) : HOMESERVER_GENERAL_RETENTION_DAYS,
    pending: savedCapDays === renderedCapDays ? null : { dms: dmsFor(savedCapDays) },
  };
}

/** From the host's results/retention-cap.json; null (no sentence) when there is no readable one. */
export function homeserverRetentionFrom(file: unknown, savedCapDays: number, general: GeneralRow | null = null): HomeserverRetention | null {
  const f = file as { v?: unknown; capDays?: unknown } | null | undefined;
  const cap = f && typeof f === "object" ? f.capDays : undefined;
  if (!f || f.v !== 1 || typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > 3650) return null;
  return homeserverRetentionFor(cap, savedCapDays, general);
}
