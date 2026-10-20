// Deactivate a person's Matrix account, with erase — the Matrix half of "Delete my account".
// SERVER ONLY.
//
// Through the homeserver's account server (MAS) admin API, as this site's own confidential
// client with the `urn:mas:admin` scope (client_credentials). The operator has to allow that:
// the client listed in MAS's `policy.data.admin_clients`, and the `adminapi` resource on a
// listener. Without it the token request is refused, `available()` says so, the confirm screen
// says the Matrix account is removed by the operator instead, and the deletion row records
// the error — never a silent half-deletion.
//
// Only accounts on THIS homeserver are deactivated (a federated account belongs to its own
// server). Codes only leave this module, never the server's text.

import { matrixServerName } from "./matrixConfig.ts";
import { masAdmin, masAdminToken, masUserByName } from "./matrixMasAdmin.ts";

/** Is this account one this homeserver owns? Its localpart, or null. Pure over the config. */
export function localpartOf(matrixId: string, serverName = matrixServerName()): string | null {
  const m = /^@([^:]+):(.+)$/.exec(matrixId);
  return m && m[2] === serverName ? m[1]! : null;
}

/** Can this site deactivate accounts here? (A token with the admin scope can be had.) */
export async function matrixEraseAvailable(): Promise<boolean> {
  const t = await masAdminToken(AbortSignal.timeout(5_000));
  return t.ok;
}

/** Deactivate + erase. `{ ok: true }`, or `{ ok: false, code }` with a fixed code. */
export async function eraseMatrixAccount(matrixId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const localpart = localpartOf(matrixId);
  if (!localpart) return { ok: false, code: "not_this_server" };
  const admin = masAdmin();
  const t = await admin.token(AbortSignal.timeout(8_000));
  if (!t.ok) return t;
  const found = await masUserByName(admin, t.token, localpart);
  if (!found.ok) return found;
  if (!found.user) return { ok: false, code: "no_such_user" };
  if (found.user.deactivated) return { ok: true };
  try {
    const d = await admin.fetch(`${admin.base}/users/${encodeURIComponent(found.user.id)}/deactivate`, {
      method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ skip_erase: false }), signal: AbortSignal.timeout(15_000),
    });
    return d.ok ? { ok: true } : { ok: false, code: `deactivate_http_${d.status}` };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}
