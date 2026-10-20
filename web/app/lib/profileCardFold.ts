import type { EncryptionVerdict } from "./encryptionMemory";

/**
 * The label of Home's folded "Settings ›" row. The encryption row doubles as
 * a warning, so folding it away must not fold the warning away: anything but
 * a green verdict rides on the folded row, verification pending first — the
 * same precedence the row itself uses in ProfileCardBody.
 */
export function settingsFoldLabel({ verdict, pendingVerification }: {
  verdict: EncryptionVerdict;
  pendingVerification: boolean;
}): string {
  if (pendingVerification) return "Settings · verification pending";
  if (verdict !== "green") return "Settings · encryption needs setup";
  return "Settings";
}
