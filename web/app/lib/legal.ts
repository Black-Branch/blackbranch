// Single source of truth for the legal pages (/legal) and /about. Every clause that names the
// operator, the contact address, the governing law or the date reads it from here.
//
// The four operator values are the install keys legal.* (env LEGAL_OPERATOR / LEGAL_CONTACT_EMAIL /
// LEGAL_GOVERNING_LAW / LEGAL_EFFECTIVE_DATE), read from the environment when web starts
// (installValues.ts) — a change applies at the next restart. There are no defaults on purpose: a
// second install must not publish somebody else's Terms, and a page that invents an operator or
// a law is worse than one that says it has none. Unset = a bracketed "not set" marker on the
// page, one boot line (legalMissing, read by instrumentation.ts), and an unset row in the Admin
// Panel. The operator supplies them.

import { installValue, type InstallKey } from "./installValues.ts";
import { siteName } from "./siteName.ts";

function legalValue(key: InstallKey, unset: string): string {
  return installValue(key).trim() || unset;
}

/** Public-facing operator / trading name. */
export const OPERATOR = legalValue("legal.operator", "[operator not set]");

/** The site's name (install key site.name). */
export const SITE_NAME = siteName();

/** Contact for legal, privacy, refund and data-deletion requests; null when the install has none. */
export const CONTACT_EMAIL: string | null = installValue("legal.contactEmail").trim() || null;

/** What a page shows where the contact address goes when the install has none. */
export const CONTACT_UNSET = "[contact e-mail not set]";

/** Governing law, as it reads after "the laws of". */
export const GOVERNING_LAW = legalValue("legal.governingLaw", "[governing law not set]");

/** Effective / last-updated date shown at the top of each section. */
export const EFFECTIVE_DATE = legalValue("legal.effectiveDate", "[date not set]");

/** Minimum age to use the service / to make payments. */
export const MIN_AGE = 13;
export const MIN_PAYMENT_AGE = 18;

/** The legal.* keys this install has no value for — the boot line names them. */
export function legalMissing(): string[] {
  const keys: InstallKey[] = ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate"];
  return keys.filter((k) => !installValue(k).trim());
}
