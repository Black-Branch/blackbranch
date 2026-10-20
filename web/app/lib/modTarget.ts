import { localMatrixId } from "./matrixConfig.ts";
// Mod-typed handle → matrix id. ONE rule for every moderation surface — the
// /command palette and the mod panel share it, so they cannot drift (two
// copies would differ on whether the leading @ is stripped before testing for
// it, and on whether an un-prefixed full id "x:host" becomes
// "@x:host:<this server>").
//
// "@name:<this server>" is right for a SITE account and wrong for a platform-only
// chatter — callers that already hold a canonical id should pass that instead
// (see AutomodHoldBar / UserCard's modTargetId).
export function resolveModTarget(input: string): string {
  const t = input.trim();
  if (t.includes(":")) return t.startsWith("@") ? t : `@${t}`;
  return localMatrixId(t);
}
