// First boot's gate: while setup is unfinished, every page sends people to /setup and every other
// API answers "being set up". Pure — proxy.ts asks /api/setup/status for the state and this file
// for the action.
//
// The gate closes ONLY on a positive reading: the settings layer has loaded, `setup.completedAt`
// is unset, and this install has a setup link (SETUP_TOKEN_HASH). A site that cannot read its
// settings fails OPEN — showing "being set up" to the public is worse than showing the site — and
// a site with no setup link can never be set up through the pages, so it is never gated (a
// long-lived install that predates setup, a copy run from source).

export type SetupGateState = "complete" | "setting-up" | "unknown";

export function setupGateState(input: { loaded: boolean; completedAt: string | null; tokenConfigured: boolean }): SetupGateState {
  if (!input.tokenConfigured) return "complete";
  if (!input.loaded) return "unknown";
  return input.completedAt ? "complete" : "setting-up";
}

// What stays reachable while the site is being set up: the setup pages and their API, sign-in
// (the first admin signs in through it), the Matrix discovery files, and what the box's health
// checks and the browser shell load.
const OPEN = [
  /^\/setup(\/|$)/,
  /^\/api\/setup(\/|$)/,
  /^\/api\/auth(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/\.well-known(\/|$)/,
  /^\/api\/client-error$/,
  /^\/_next(\/|$)/,
  /^\/robots\.txt$/,
  /^\/manifest\.webmanifest$/,
  /^\/offline\.html$/,
];

export function setupPathOpen(path: string): boolean {
  return OPEN.some((re) => re.test(path));
}

/**
 * The setup API's rule — the OPPOSITE default from the public gate. A public page may fail open
 * (showing the site beats showing "being set up"), but the setup routes hand out the backup
 * passphrase, make accounts and write .env values: when the state is unknown they refuse, so a
 * finished install whose settings are momentarily unloaded never reopens its setup pages.
 * null = the setup API may run.
 */
export function setupApiRefusal(state: SetupGateState): { status: number; error: string } | null {
  if (state === "setting-up") return null;
  if (state === "complete") return { status: 409, error: "setup is finished — use the Admin Panel" };
  return { status: 503, error: "the site's settings are not loaded yet — try again in a moment" };
}

export type GateAction = "pass" | "redirect" | "unavailable";

export function gateAction(path: string, state: SetupGateState): GateAction {
  if (state !== "setting-up" || setupPathOpen(path)) return "pass";
  return path === "/api" || path.startsWith("/api/") ? "unavailable" : "redirect";
}
