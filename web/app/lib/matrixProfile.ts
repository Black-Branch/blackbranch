// Server-side Matrix profile helper — the one place that talks to the homeserver
// `/profile` REST endpoints. Both directions of profile sync go through here:
//   - reads  (getMatrixProfile)        — Matrix → site reconcile
//   - writes (setMatrix* convenience)  — site → Matrix (color / displayname / avatar)
// Replaces the per-route hand-rolled `fetch(`${homeserver}/.../profile/{id}/<field>`)`
// boilerplate previously duplicated in me/color, me/displayname and avatar/upload.

import { sanitizeDisplayName } from "./sanitize";
import { homeserverFetch } from "./homeserverFetch";
import { readJsonCapped } from "./boundedBody";
import { USERNAME_COLOR } from "./matrixNamespace";
import { profileFieldColor } from "./matrixProfileColor";
import { MXC_RE } from "./matrixHtml";

export type MatrixProfile = {
  displayName: string | null;
  avatarMxc: string | null;
  color: string | null;
};

/** One profile key's answer: a display name, an mxc URL or a colour — a few hundred bytes. */
const PROFILE_KEY_MAX_BYTES = 16 * 1024;

// Every request here goes through homeserverFetch, whose default deadline covers the body read:
// a federated account's homeserver is the one answering, and reconcile reads 2+N keys at once.

function profileUrl(homeserver: string, matrixId: string, key: string): string {
  return `${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(matrixId)}/${key}`;
}

// Read one profile key. 404 (key unset) / any error → null. Per-key GETs are the
// proven path (the avatar routes already use them) and avoid relying on the
// extended-profile bulk endpoint being enabled on the homeserver.
async function getKey(
  homeserver: string,
  matrixId: string,
  key: string,
  token?: string | null,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> | undefined = token
    ? { Authorization: `Bearer ${token}` }
    : undefined;
  const res = await homeserverFetch(profileUrl(homeserver, matrixId, key), {
    headers,
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const json = await readJsonCapped(res, PROFILE_KEY_MAX_BYTES);
  return json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
}

// Pull a user's Matrix profile (displayname, avatar mxc, username colour). Each field
// is independently optional — a missing/invalid value comes back as null so callers
// can decide whether to mirror or leave the existing site value alone.
export async function getMatrixProfile(
  homeserver: string,
  matrixId: string,
  token?: string | null,
): Promise<MatrixProfile> {
  const [dn, av, ...colorBodies] = await Promise.all([
    getKey(homeserver, matrixId, "displayname", token),
    getKey(homeserver, matrixId, "avatar_url", token),
    ...USERNAME_COLOR.read.map((field) => getKey(homeserver, matrixId, field, token)),
  ]);

  // Sanitize here, not at the call site. The sibling fields below are
  // validated in this function too (mxc:// prefix, #rrggbb), and the
  // displayname is written straight to site.users.display_name, which renders
  // as `username` in chat, history, pins, votes, the mod log and the ban list.
  //
  // It is not a trusted value: /api/matrix/token hands the browser its own raw
  // Matrix access token, so any signed-in user can PUT their displayname directly
  // to the homeserver with bidi overrides, zero-width padding or 400 characters,
  // then call reconcile to pull it in. Sanitizing at the source means a second
  // reader can't reintroduce the hole by forgetting to call it.
  //
  // Empty after sanitizing (e.g. a name that was nothing but zero-width chars)
  // collapses to null, which the reconcile UPDATE's COALESCE then ignores — so a
  // hostile name leaves the existing good value alone rather than blanking it.
  const displayNameRaw = dn?.displayname;
  const displayName =
    typeof displayNameRaw === "string" ? sanitizeDisplayName(displayNameRaw) || null : null;

  const avatarRaw = av?.avatar_url;
  const avatarMxc =
    typeof avatarRaw === "string" && MXC_RE.test(avatarRaw) ? avatarRaw : null;

  const color = profileFieldColor((field) => colorBodies[USERNAME_COLOR.read.indexOf(field)] ?? null);

  return { displayName, avatarMxc, color };
}

// Write one profile key (`body`), or clear it (`null` → DELETE, MSC4133). Returns whether the
// homeserver accepted it; callers that fire-and-forget can ignore the result.
async function setMatrixProfileField(
  homeserver: string,
  matrixId: string,
  token: string,
  field: string,
  body: Record<string, unknown> | null,
): Promise<boolean> {
  const res = await homeserverFetch(profileUrl(homeserver, matrixId, field), body === null
    ? { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    : {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
  // Only the status matters; release the connection rather than leave the answer unread.
  void res?.body?.cancel().catch(() => {});
  return Boolean(res?.ok);
}

export const setMatrixDisplayName = (
  homeserver: string,
  matrixId: string,
  token: string,
  name: string,
) => setMatrixProfileField(homeserver, matrixId, token, "displayname", { displayname: name });

export const setMatrixAvatarUrl = (
  homeserver: string,
  matrixId: string,
  token: string,
  mxc: string,
) => setMatrixProfileField(homeserver, matrixId, token, "avatar_url", { avatar_url: mxc });

// The username colour's Matrix copy, under the product field (write-new). MSC4133 keys the body by
// the field name — `{ "<field>": "#rrggbb" }` — and clears a field with DELETE. A `{ color }`
// body is refused by the server with 400. site.users stays the colour the UI uses: reconcile
// never pulls this copy back.
export const setMatrixColor = (
  homeserver: string,
  matrixId: string,
  token: string,
  color: string | null,
) => setMatrixProfileField(homeserver, matrixId, token, USERNAME_COLOR.write, color === null ? null : { [USERNAME_COLOR.write]: color });
