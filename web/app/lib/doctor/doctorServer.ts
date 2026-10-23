// The doctor page's server side and the command's door into the site. SERVER ONLY.
//
// The list and every verdict are config/doctor.mjs's (copied here as doctor.generated.mjs); this
// file joins the two halves of the facts: the host's, which `blackbranch` writes into the results
// folder, and the site's (doctorFacts.ts). "Check again" asks the host for fresh facts through the
// request folder (verb `doctor`) and waits for its answer.

import { shownRows } from "./doctorRowsShown";
import { DOCTOR } from "../doctor.generated.mjs";
import type { DoctorRow } from "../doctor.generated.mjs";
import { answers, hostFile, hostRequestsAvailable, hostResult, requestHost } from "../hostRequests";
import { gatherSiteFacts } from "./doctorFacts";

export type DoctorView = {
  rows: DoctorRow[];
  bundle: boolean;
  hostAt: string | null;
  siteAt: string;
  /** Set when "Check again" could not get fresh host facts. */
  hostNote?: string;
};

type HostFacts = { at?: unknown };

async function readHostFacts(): Promise<HostFacts | null> {
  const f = await hostFile("doctor-host.json");
  return f && typeof f === "object" && (f as { v?: unknown }).v === 1 ? (f as HostFacts) : null;
}

export async function doctorView(hostNote?: string): Promise<DoctorView> {
  const bundle = hostRequestsAvailable();
  const [host, site] = await Promise.all([bundle ? readHostFacts() : Promise.resolve(null), gatherSiteFacts()]);
  const rows = DOCTOR.evaluate({ host, hostState: !bundle ? "none" : host ? "ok" : "missing", site, siteError: null });
  // The page lists the leftover-of-an-older-install checks only once set (doctorRowsShown.ts).
  return { rows: shownRows(rows), bundle, hostAt: typeof host?.at === "string" ? host.at : null, siteAt: site.at, ...(hostNote ? { hostNote } : {}) };
}

/** "Check again": ask the host for fresh facts (a bundle only), wait up to `waitMs` for its
 *  answer, then evaluate. */
export async function doctorRecheck(waitMs = 45_000): Promise<DoctorView> {
  if (!hostRequestsAvailable()) return doctorView();
  const asked = await requestHost("doctor");
  if (!asked.ok) return doctorView(asked.error);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const r = await hostResult("doctor");
    if (answers(r, asked.requestedAt)) return doctorView(r.ok ? undefined : `the host could not check: ${r.message}`);
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return doctorView("the host did not answer in time (is blackbranch-requests.path running?) — showing its last facts");
}
