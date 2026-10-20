// The ONE consent predicate for showing a canonical's cross-platform link — config/public-id.mjs
// noOptOutSql, the same text stream-api's sponsor pool uses. Every web reader of
// site.users.show_links goes through here (linkConsent.test.ts holds them to it). Pure.
import { PUBLIC_ID } from "./publicId.generated.mjs";
import { NATIVE_SQL } from "./nativePlatform.ts";

/** SQL: no site account linked to `canonicalExpr` (by either link table) has show_links off.
 *  `canonicalExpr` is developer-written SQL (a column or a placeholder) — never input. */
export function noOptOutSql(canonicalExpr: string): string {
  return PUBLIC_ID.noOptOutSql(canonicalExpr, NATIVE_SQL);
}
