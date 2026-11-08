// The Discord page's routes, wired to this process: the pool, the host's drop box (every call to the
// bridge is the host's: the bridge's token never reaches the site), the doctor's Discord bridge row.
// SERVER ONLY. The handlers are discordAdmin.ts.
import pool from "@/lib/db";
import { answers, hostRequestsAvailable, hostResult, requestHost } from "../hostRequests";
import { instanceBool, instanceString } from "../instanceConfigServer";
import { doctorView } from "../doctor/doctorServer";
import { bridgeStateFrom, type DiscordDeps, type BridgeState } from "./discordAdmin";
import type { BridgeAnswer, BridgeCall } from "./discordLink";
import { readBridgeLinks } from "./desiredServer";

/** How long a call waits for the host's answer (the bridge's own call takes seconds; linking a room
 *  syncs it first), and how often it looks. */
const CALL_WAIT_MS = 45_000;
const CALL_STEP_MS = 500;

/** The host's answer (results/discord-call.json) parsed: link.js's JSON line is its message. */
function bridgeAnswerFrom(message: string): BridgeAnswer | null {
  try {
    const j = JSON.parse(message) as Record<string, unknown>;
    if (typeof j.ok !== "boolean" || !(j.status === null || typeof j.status === "number") || typeof j.data !== "string") return null;
    return { ok: j.ok, status: j.status, data: j.data };
  } catch { return null; }
}

/** One call: the request, then the answer to THAT request (its name and time), or null. */
const call: BridgeCall = async (verb) => {
  const asked = await requestHost(verb);
  if (!asked.ok) return { hostRefused: asked.error };
  for (let waited = 0; waited <= CALL_WAIT_MS; waited += CALL_STEP_MS) {
    const a = await hostResult("discord-call");
    if (answers(a, asked.requestedAt) && a.request === verb) {
      if (!a.ok) return { hostRefused: a.message };
      return bridgeAnswerFrom(a.message) ?? { hostRefused: "its answer could not be read" };
    }
    await new Promise((r) => setTimeout(r, CALL_STEP_MS));
  }
  return null;
};

async function hubRoomId(): Promise<string | null> {
  const { rows } = await pool.query<{ matrix_room_id: string | null }>(
    `SELECT matrix_room_id FROM site.community_spaces WHERE kind = 'hub' AND matrix_room_id IS NOT NULL ORDER BY id LIMIT 1`);
  return rows[0]?.matrix_room_id ?? instanceString("matrix.rooms.hub");
}

async function bridgeState(): Promise<BridgeState> {
  return bridgeStateFrom((await doctorView()).rows.find((r) => r.id === "discord.bridge"));
}

async function runFinishedSince(iso: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM site.community_runs WHERE mode = 'apply' AND finished_at IS NOT NULL AND started_at >= $1::timestamptz - interval '5 seconds' LIMIT 1`, [iso]);
  return rows.length > 0;
}

export function discordDeps(admin?: string): DiscordDeps {
  return {
    pool, admin,
    call,
    canCall: hostRequestsAvailable(),
    hubRoomId,
    links: readBridgeLinks,
    askHost: (verb) => requestHost(verb),
    hostAnswer: () => hostResult("discord-links"),
    reconcile: instanceBool("community.reconciler") ? () => requestHost("community-reconcile") : null,
    runFinishedSince,
    bridgeState,
  };
}
