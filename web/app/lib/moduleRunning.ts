// Whether a module is ON for the purpose of showing it — the module rule (config/modules.mjs,
// "ONE RULE") as web applies it. Pure, so node --test can load it.
//
// A module's switch is applied by the process that SERVES the module, when that process starts
// (`reload: 'restart'`). Web shows such a module's part — the radio's tab, a feature named on the
// About page — from what that process RUNS, read from its own report (stream-api's GET /config:
// `self` for stream-api, `reports[<package>]` for the others), never from the saved switch. A
// module only web reads (stripe, paypal) is web's own and applies at once.

type ModuleLike = { id: string; packages: readonly string[] };
type KeyReport = Record<string, { display?: unknown } | undefined>;

/** The part of stream-api's GET /config this reads. */
export type ServingSnapshot = {
  self?: KeyReport;
  reports?: Record<string, { keys?: KeyReport } | undefined>;
} | null;

/** The process whose start applies this module's switch: stream-api when it runs the module,
 *  else the other server process that reads it, else web itself. */
function servingPackage(m: ModuleLike): string {
  if (m.packages.includes("stream-api")) return "stream-api";
  return m.packages.find((p) => p !== "web") ?? "web";
}

/**
 * Is the module on, as the process that serves it runs it? `savedOn` is web's own reading of the
 * switch: the answer for a web-only module, and the fallback while the serving process has not
 * said (unreachable, or it has not reported yet).
 */
export function moduleRunning(m: ModuleLike, snap: ServingSnapshot, savedOn: boolean): boolean {
  const pkg = servingPackage(m);
  if (pkg === "web") return savedOn;
  const key = `modules.${m.id}`;
  const shown = pkg === "stream-api" ? snap?.self?.[key]?.display : snap?.reports?.[pkg]?.keys?.[key]?.display;
  return typeof shown === "boolean" ? shown : savedOn;
}
