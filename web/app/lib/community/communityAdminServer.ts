// The Community page's routes, wired to this process: the pool, the host's drop box and the
// install's settings. SERVER ONLY. The handlers themselves are communityAdmin.ts.
import pool from "@/lib/db";
import { hostRequestsAvailable, hostResult, requestHost } from "../hostRequests";
import { instanceBool, instanceList, instanceResolve } from "../instanceConfigServer";
import { instanceEntry } from "../instanceSchema.generated.mjs";
import type { AskResult, CommunityDeps } from "./communityAdmin";
import { decodeSetupChannels } from "./setupChannels";

const CAP_KEY = "community.retentionCapDays";

/** The install's cap in days; 0 = no limit. Unreadable, the schema's own default (no second copy here). */
export function retentionCapDays(): number {
  const v = instanceResolve(CAP_KEY).value;
  return typeof v === "number" ? v : Number(instanceEntry(CAP_KEY)?.default);
}

/** The channels the setup pages listed, with the cap their days stay within: the hub's first
 *  import turns them into rows (adoptServer.ts). Read per request. */
export function setupChannelsNow() {
  return { channels: decodeSetupChannels(instanceList("community.setupChannels")), retentionCapDays: retentionCapDays() };
}

/** Off (community.reconciler false) the host is not asked: a save is kept until it is turned on. */
async function askApply(): Promise<AskResult> {
  if (!instanceBool("community.reconciler")) return { ok: false, error: "the reconciler is off on this install" };
  return requestHost("community-reconcile");
}

/** The deps every save uses: the pool, an apply request, the retention cap. */
export function communityDeps(admin: string): CommunityDeps {
  return { pool, ask: askApply, retentionCapDays, admin, hostAnswer: () => hostResult("community-reconcile") };
}

/** The Run now buttons: an apply (only while the reconciler is on) or a report. */
export function askMode(mode: "report" | "apply"): Promise<AskResult> {
  if (mode === "apply") return askApply().then((r) => (r.ok ? r : { ok: false, error: "Changes are applied by the reconciler when it is turned on." }));
  if (!hostRequestsAvailable()) return Promise.resolve({ ok: false, error: "This install cannot start a check from here." });
  return requestHost("community-report");
}

/** The read: settings and the host's last answer beside the rows. */
export function communityViewDeps() {
  return {
    pool, retentionCapDays,
    reconciler: instanceBool("community.reconciler"),
    canAsk: hostRequestsAvailable(),
    host: () => hostResult("community-reconcile"),
    hostReport: () => hostResult("community-report"),
  };
}
