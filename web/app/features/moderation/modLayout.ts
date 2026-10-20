// The Mod Panel's places, as data: Display · Automod queue · Slow mode · Purge in ONE place,
// "Chat controls", plus Bans (kept on purpose — the user card's shield opens it).
// Pure, so node --test can read it and prove no label is also an Admin Panel label.
import type { PanelPlace } from "../../lib/panelSearch.ts";

export const MOD_PLACES = [
  { key: "chat", label: "Chat history", words: "messages search jump inspect scores platforms emotes follow" },
  // "History", named so no label is in both panels: the Admin Panel has "Payment history".
  { key: "history", label: "Mod history", words: "log actions bans timeouts deletes propagation retry" },
  { key: "bans", label: "Bans", words: "timeout ban unban active" },
  { key: "reports", label: "Reports", words: "reported flagged users messages viewers complaints resolve" },
  { key: "controls", label: "Chat controls", words: "display show deleted messages struck slow mode cooldown rate automod queue held flagged marks blacklist whitelist words hosts ai purge remove hours" },
  { key: "lockdown", label: "Lockdown", words: "raid signups cross-posting account age ingest sub only expiry" },
  { key: "identity", label: "Identity links", words: "merge link accounts canonical" },
] as const;

export type ModPlace = (typeof MOD_PLACES)[number]["key"];

/** Where a user card's shield opens the panel: Bans, with the person prefilled (Purge too). */
export const MOD_TARGET_PLACE: ModPlace = "bans";

export function isModPlace(s: string | null | undefined): s is ModPlace {
  return MOD_PLACES.some((p) => p.key === s);
}

/** The places a search matches: name or words. An empty query matches all. */
export function modSearch(query: string): ModPlace[] {
  const q = query.trim().toLowerCase();
  return MOD_PLACES.filter((p) => !q || `${p.label} ${p.words}`.toLowerCase().includes(q)).map((p) => p.key);
}

/** The Mod Panel places a query matches, for the Admin Panel's search. An
 *  empty query lists nothing. */
export function searchModPlaces(query: string): PanelPlace[] {
  if (!query.trim()) return [];
  return modSearch(query).map((key) => ({ panel: "mod", id: key, label: MOD_PLACES.find((p) => p.key === key)!.label }));
}
