import { signOut } from "next-auth/react";
import { postJson } from "@/app/lib/http";
import { clearAllMatrixDatabases } from "@/app/lib/MatrixClientContext";
import { clearDeviceId } from "@/app/lib/deviceId";
import { forgetAllVerdicts } from "@/app/lib/encryptionMemory";
import { runSignOutHooks } from "@/app/lib/plugins/session";

// Sign-out destroys the whole session unit together: server session (revokes
// tokens; MAS deletes the Synapse device), local crypto stores, AND the device
// ID. The next sign-in mints a fresh device — never reuse a device ID whose
// OlmMachine is gone (OTK-conflict invariant). Fire-and-forget: page navigates
// away via signOut.
export function signOutEverything(): void {
  postJson("/api/matrix/logout").catch(() => {});
  clearAllMatrixDatabases().catch(() => {});
  clearDeviceId();
  // The cached E2EE verdict describes the crypto stores and device id being
  // destroyed on the two lines above, so it has to go with them — otherwise the
  // next account on this browser inherits "encryption ready" from a device that
  // no longer exists.
  forgetAllVerdicts();
  // What the install's plugin keeps for this person (a console's saved session) is theirs too.
  runSignOutHooks();
  signOut({ callbackUrl: "/" });
}
