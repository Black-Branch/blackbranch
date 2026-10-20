// What the sign-in page offers and says, from the install's settings. Pure: the page's server half
// reads the settings and passes them in.

export type SignInOptions = {
  /** The "use a Matrix account from another server" box: hidden when federated sign-in is off. */
  federated: "off" | "on" | "allowlist";
  /** What the page can say about new accounts on this site's own homeserver. */
  signup: "open" | "closed" | "unknown";
};

/** Whether a new person can make an account here, as far as this install knows. The bundle renders
 *  sign-up from `matrix.registration` (unset = closed) and keeps it closed while setup runs; a
 *  homeserver the bundle does not run keeps its own setting, which the site cannot read. */
export function signupState(o: { bundle: boolean; registration: string | null; setupDone: boolean }): SignInOptions["signup"] {
  if (!o.bundle) return "unknown";
  return o.setupDone && o.registration === "open" ? "open" : "closed";
}

/** The line under the Sign in button about new accounts. */
export function signupLine(signup: SignInOptions["signup"], site: string): string {
  if (signup === "open") return `New here? Signing in creates your free ${site} account.`;
  if (signup === "closed") return `New accounts are not open on ${site} right now — existing accounts can sign in.`;
  return `New here? If ${site} is taking new accounts, the sign-in page lets you make one.`;
}

/** The sentence under the "another server" divider, or null when the box is not shown. */
export function federatedLine(mode: SignInOptions["federated"]): string | null {
  if (mode === "off") return null;
  if (mode === "allowlist") return "Only accounts on the servers this site allows can sign in this way.";
  return "";
}
