// The site's own Matrix data types — the forum flag, the post fields, the username-colour profile
// field, the mute push-rule id, the hidden/ignored account data — carry the PRODUCT's namespace:
// the same in every install, a protocol constant and never instance config.
//
// Each name moves in three steps:
//   1. READ-BOTH — every reader accepts the product name first, then the legacy one.
//   2. WRITE-NEW — `write` is the product name; readers still accept the legacy one. ← this step
//   3. Stopping the old read — one change per storage class, each citing its count.
// The legacy prefix is this install's, not the product's: the install key matrix.legacyNamespace
// (an install value). A fresh install has no data under an older prefix, so with the key unset every
// reader and writer uses the product name alone. Only this file reads the key
// (matrixNamespace.test.ts pins the read-both names; matrixNamespaceFresh.test.ts the unset case).
import { installValue } from "./installValues.ts";

/** The product's namespace (reverse-DNS of blackbranch.app). */
const PRODUCT_NAMESPACE = "app.blackbranch";
/** legacy-read: the install's pre-product prefix, or null. Readers keep accepting it until each
 *  storage class's "old read can stop" condition is met; no writer uses it. */
const LEGACY_NAMESPACE: string | null = installValue("matrix.legacyNamespace").trim() || null;

export type NamespacedName = {
  /** The name every writer uses: the product name (write-new). */
  readonly write: string;
  /** Every name a reader accepts, the product name first (then the legacy one, when the install has one). */
  readonly read: readonly [product: string] | readonly [product: string, legacy: string];
};

/** Does this install carry a legacy prefix? The doctor fails a baseline install that does. */
export function legacyNamespaceSet(): boolean {
  return LEGACY_NAMESPACE !== null;
}

function namespaced(suffix: string): NamespacedName {
  const product = `${PRODUCT_NAMESPACE}.${suffix}`;
  if (!LEGACY_NAMESPACE) return { write: product, read: [product] };
  return { write: product, read: [product, `${LEGACY_NAMESPACE}.${suffix}`] };
}

/** Room state: `{ type: "forum" }` flags a forum room. */
export const ROOM_TYPE = namespaced("room_type");
/** Message content fields of a forum post. */
export const FORUM_TITLE = namespaced("forum.title");
export const FORUM_TAGS = namespaced("forum.tags");
export const FORUM_BODY = namespaced("forum.body");
/** Profile field (MSC4133) holding the username colour. */
export const USERNAME_COLOR = namespaced("username_color");
/** Push-rule id prefix of the site's own mute rule: `<prefix>.<roomId>`. */
export const MUTE_RULE = namespaced("mute");
/** Account data: the ids the site itself added to the ignore list. */
export const HIDDEN_PEOPLE = namespaced("hidden_people");
export const IGNORED_BOTS = namespaced("ignored_bots");

/** The first value `get` finds under `name.read`, product name first; undefined when neither has one.
 *  `get` returns undefined/null for "not there" — including a value of the wrong shape, so a
 *  malformed product-name value falls back to the legacy one instead of hiding it. */
export function readFirst<T>(name: NamespacedName, get: (key: string) => T | null | undefined): T | undefined {
  for (const key of name.read) {
    const v = get(key);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
