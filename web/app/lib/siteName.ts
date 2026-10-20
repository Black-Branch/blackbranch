import { installValue } from "./installValues.ts";
// The site's display name — what a viewer reads as "the name of this site".
//
// The ONE place it is written. Everything that shows the site's name calls
// this rather than spelling it out, so the instance settings layer replaces a
// single line instead of chasing copies. Counted in
// tools/owner-literals.baseline.json; that entry is meant to reach zero.
//
// The install key site.name (env SITE_NAME, alias NEXT_PUBLIC_SITE_NAME), read
// from the environment when web starts — server and client read the same value
// (installValues.ts), and a change applies at the next restart. No default: web
// refuses to boot without one.
//
// Not to be confused with the site's ORIGIN (authOrigin.ts) or its domains:
// this is a label, and it may stop looking like a domain at all.

export function siteName(): string {
  return installValue("site.name");
}
