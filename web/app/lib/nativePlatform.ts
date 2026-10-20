import { installValue } from "./installValues.ts";
// The platform id of the site's OWN chat, accounts and money — what a native message, a site
// account's identity link (stream.links) and a support event paid on the site are stored and sent
// as. The product's word is "native" in every install; the label people see is the site's name
// (platforms.ts). Server and client read the same module.
//
// An install that stored an older word for it (the install key site.legacyId, an install value)
// has nothing stored under that word any more once it has migrated. It can still ARRIVE: from a
// page opened before the rename (a request body, a popout link) and from a returning
// visitor's browser storage (legacyStorage.ts). normalizePlatform maps it at those doors; nothing
// behind them knows it. A fresh install leaves the key unset.

/** The product's id for the site's own platform. */
export const NATIVE_PLATFORM = "native";

const rawLegacy = installValue("site.legacyId").trim();
/** This install's word from before the rename (site.legacyId), or null. Validated: it names
 *  browser storage, so anything but one lower-case word is ignored. */
const LEGACY_NATIVE_PLATFORM: string | null = /^[a-z][a-z0-9]{1,31}$/.test(rawLegacy) && rawLegacy !== NATIVE_PLATFORM ? rawLegacy : null;

/** The id as a SQL list: `platform IN ${NATIVE_SQL}` / `NOT IN`. A constant — never request input. */
export const NATIVE_SQL = `('${NATIVE_PLATFORM}')`;

/** Is `p` the site's own platform? */
export function isNativePlatform(p: unknown): boolean {
  return p === NATIVE_PLATFORM;
}

/** `p` with the install's old word for the site's own platform read as "native"; any other value
 *  unchanged. For a value that came in from outside (a request, a link, stored browser data) and
 *  for looking a platform up in a display map. */
export function normalizePlatform<T extends string | null | undefined>(p: T): T | string {
  return LEGACY_NATIVE_PLATFORM !== null && p === LEGACY_NATIVE_PLATFORM ? NATIVE_PLATFORM : p;
}

/** The install's old word, for carrying a returning visitor's browser storage forward (layout.tsx's
 *  first-paint script, legacyStorage.ts), or null. */
export function legacyNativePlatform(): string | null {
  return LEGACY_NATIVE_PLATFORM;
}
