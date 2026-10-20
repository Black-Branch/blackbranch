// Where the site reaches the account server's admin API. The bundle serves it only on MAS's
// internal listener (install/matrix/render.sh), which the router never routes — so the site must be
// told that address (MAS_ADMIN_URL); a homeserver the bundle did not render keeps the old answer, the
// issuer's own path.
import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { masAdmin } from "./matrixMasAdmin.ts";

test("the admin API base: MAS_ADMIN_URL when set, else under the issuer", () => {
  assert.equal(masAdmin({}).base, "https://matrix.example.tv/auth/api/admin/v1");
  assert.equal(masAdmin({ MAS_ADMIN_URL: "  " }).base, "https://matrix.example.tv/auth/api/admin/v1", "blank = unset");
  assert.equal(masAdmin({ MAS_ADMIN_URL: "http://mas:8081/api/admin/v1/" }).base, "http://mas:8081/api/admin/v1");
});
