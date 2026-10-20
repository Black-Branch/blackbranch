// Automod on a site message before delivery. SERVER ONLY.
//
// The send route asks after the word filter, the length check and the link gate, and BEFORE the
// redaction gates and any spend or debit — the slot the two existing holds use, so a held paid
// message is never charged. stream-api runs the check within `automod.holdBudgetMs` and writes the
// held row itself; this side measures the same budget around the call (plus the localhost hop)
// and delivers unchecked when it passes — automod fails open.
//
// Who is exempt is decided HERE, from server-side facts only: staff, mods, admins and the bot
// (the route's isPrivileged, from the account row and the staff list), a wholly encrypted message
// (never sent to a provider), and paying supporters when the install says so. Nothing the sender
// TYPES can claim an exemption — which is why there is no "command" exemption: a message starting
// with `!` or `/` that reaches posting is a message, and the send route asks only after the
// commands it handles have returned.

import { instanceResolve } from "./instanceConfigServer.ts";
import { streamApiFetch } from "./streamApi.ts";

/** The localhost hop on top of stream-api's own budget. */
const HOP_MS = 150;

export type AutomodExemption = { isPrivileged: boolean; wholeRedacted: boolean; isSupporter: boolean; skipSupporters: boolean };

/** Is this message exempt from the check? Pure, over server-side facts only. */
export function automodExempt(x: AutomodExemption): boolean {
  return x.isPrivileged || x.wholeRedacted || (x.skipSupporters && x.isSupporter);
}

export function automodEnabled(): boolean {
  return instanceResolve("automod.enabled").value === true;
}

export function skipSupporters(): boolean {
  return instanceResolve("automod.skipSupporters").value === true;
}

/**
 * Ask stream-api. Resolves `{ held: true, rowId }` when the message is held, `{ held: false }`
 * otherwise — including every failure (a timeout, stream-api down, a malformed answer): the
 * message is then delivered unchecked.
 */
export async function askAutomod(args: { matrixId: string; username: string | null; text: string }): Promise<{ held: true; rowId: number } | { held: false; refused?: true }> {
  const v = instanceResolve("automod.holdBudgetMs").value;
  const budget = typeof v === "number" && v > 0 ? v : 1200;
  try {
    const res = await streamApiFetch("/automod/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matrixId: args.matrixId, username: args.username, text: args.text, budgetMs: budget }),
    }, budget + HOP_MS);
    if (!res.ok) return { held: false };
    const j = (await res.json().catch(() => null)) as { held?: unknown; rowId?: unknown; refused?: unknown } | null;
    if (j?.held === true && Number.isInteger(j.rowId)) return { held: true, rowId: j.rowId as number };
    // Risky, and the sender already has holds waiting: not posted, not queued.
    if (j?.refused === "too_many_pending") return { held: false, refused: true };
    return { held: false };
  } catch {
    return { held: false };
  }
}
