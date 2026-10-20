// The DM window's and /announce's calls to the web server.
import { postJson } from "../http.ts";
import type { DmPerson } from "./bus.ts";

/** The longest announcement — stream-api's /chat/announce holds the same limit. */
export const ANNOUNCE_MAX = 300;

export type ResolveResult = { ok: true; people: DmPerson[] } | { ok: false; reason: "signin" | "banned" | "failed" };

/** A typed name → the site accounts it can mean (exact matches first; empty = nobody). */
export async function resolveDmName(name: string): Promise<ResolveResult> {
  try {
    const res = await fetch(`/api/dm/resolve?q=${encodeURIComponent(name.trim())}`);
    if (res.status === 401) return { ok: false, reason: "signin" };
    if (res.status === 403) return { ok: false, reason: "banned" };
    if (!res.ok) return { ok: false, reason: "failed" };
    const d = (await res.json()) as { people?: DmPerson[] };
    return { ok: true, people: Array.isArray(d.people) ? d.people : [] };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Nudge `to`'s open pages to look for the DM just sent (best-effort; a failure only means the
 *  recipient sees it when they next open messages). */
export function pingDm(to: string): void {
  void postJson("/api/dm/ping", { to }).catch(() => {});
}

/** The newest nudge stamp waiting for THIS viewer (0 = none), or null when signed out or the
 *  server did not answer. Only the viewer's own session can ask (nudgeBox.ts). */
export async function latestDmNudge(): Promise<number | null> {
  try {
    const res = await fetch("/api/dm/ping", { cache: "no-store" });
    if (!res.ok) return null;
    const d = (await res.json()) as { at?: unknown };
    return typeof d.at === "number" && Number.isFinite(d.at) ? d.at : null;
  } catch {
    return null;
  }
}

/** Send an announcement. Null on success, else the sentence to show. */
export async function sendAnnouncement(text: string): Promise<string | null> {
  try {
    const res = await postJson("/api/mod/announce", { text });
    if (res.ok) return null;
    if (res.status === 401) return "Sign in first.";
    if (res.status === 403) return "Announcements are for mods.";
    if (res.status === 429) return "One announcement every 30 seconds.";
    const d = (await res.json().catch(() => null)) as { error?: string } | null;
    return d?.error ?? "Couldn't send the announcement.";
  } catch {
    return "Couldn't send the announcement.";
  }
}
