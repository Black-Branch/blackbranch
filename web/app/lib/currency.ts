import { installValue } from "./installValues.ts";
// The site currency's WORDS — its name, symbol, icon — and the vote score's name. Universal:
// server and client read the same install values (installValues.ts), like siteName().
//
// Every piece of text that names the currency goes through here. A fresh install says
// "points"; an install sets its own word (e.g. CURRENCY_NAME=Gem) in its environment, and it
// applies when web restarts.
//
// The fallbacks below are only what a process WITHOUT a build reads (node --test): next.config.ts
// resolves every install key with the schema's product default, so a real build always carries a
// value. currency.test.ts pins NEUTRAL to the schema's defaults, so the two cannot drift.

/** @test-only currency.test.ts compares these with config/instance-schema.mjs's product defaults. */
export const NEUTRAL = { name: "point", namePlural: "points", symbol: "pts", scoreName: "Karma" } as const;

function built(key: "currency.name" | "currency.namePlural" | "currency.symbol" | "currency.icon" | "community.scoreName", fallback: string): string {
  return installValue(key) || fallback;
}

/** The name as written: singular for exactly 1, else the plural. "Qorm" / "point" / "points". */
export function currencyName(n?: number): string {
  return n === 1 ? built("currency.name", NEUTRAL.name) : built("currency.namePlural", NEUTRAL.namePlural);
}

/** The name with its first letter up, for a heading or the start of a sentence: "Points". */
export function currencyTitle(n?: number): string {
  const s = currencyName(n);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A count and its name: "150 Qorm", "150 points", "1 point". The number is grouped ("1,475"). */
export function currencyLabel(n: number): string {
  return `${Math.round(n).toLocaleString()} ${currencyName(Math.round(n))}`;
}

/** True when the name has no plural of its own (singular = plural, like "Qorm"): such a word
 *  takes "is" / "it" ("Qorm is the site currency"), a counted plural takes "are" / "them". The one
 *  switch that lets a neutral sentence read right while an install's own reads exactly as before. */
export function currencyIsMass(): boolean {
  return built("currency.name", NEUTRAL.name) === built("currency.namePlural", NEUTRAL.namePlural);
}

/** The compact mark after a number ("q", "pts") — coins.ts formatCoinsShort places it. */
export function currencySymbol(): string {
  return built("currency.symbol", NEUTRAL.symbol);
}

/** The icon's address, or null for the built-in coin glyph. */
export function currencyIcon(): string | null {
  return installValue("currency.icon") || null;
}

/** The name of a person's vote score: "Social credit" / "Karma". */
export function scoreName(): string {
  return built("community.scoreName", NEUTRAL.scoreName);
}

/** Its last word, capitalised — the per-100-messages board's label stem: "Credit" / "Karma". */
export function scoreShortName(): string {
  const words = scoreName().trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** The thank-you line after a tip or a purchase: "500 Qorm is on its way to your wallet." /
 *  "500 points are on their way to your wallet." One sentence, one place, for both done views. */
export function currencyOnItsWay(n: number): string {
  return `${currencyLabel(n)} ${currencyIsMass() ? "is on its way" : "are on their way"} to your wallet.`;
}
