"use client";

// A site ban reaches the community rooms: everyone with an active site ban or timeout is banned
// from every community channel, and let back in when it ends — reconciled from a moderator's own
// client, like mod power (useModPowerSync), because the site holds no homeserver credential that
// may ban in the rooms; a moderator's account can (power 50). Runs while a mod has the community
// open: on open, every two minutes, and at once after a ban from this tab.
//
// Only bans this sync made are lifted: they carry SITE_BAN_REASON. A ban a mod made in a room by
// hand (the member card) is the room's own and stays.

import { useEffect, useRef } from "react";
import { attemptWithRetry } from "./matrixModerate.ts";

/** The reason written on a room ban made for a site ban — how the sync knows which bans are its own.
 *  @test-only used in this file; the test builds room bans carrying it. */
export const SITE_BAN_REASON = "Banned on the site";

/** Fired after a ban or unban from this tab, so an open community reconciles at once. */
export const SITE_BANS_CHANGED = "bb:site-bans-changed";

const EVERY_MS = 2 * 60_000;

type Member = { userId: string; powerLevel: number; membership?: string; events?: { member?: { getContent(): { reason?: unknown } } | null } };

/** The slice of Room this reads; an SDK Room satisfies it. */
export type BanSyncRoom = {
  roomId: string;
  currentState: { hasSufficientPowerLevelFor(action: string, powerLevel: number): boolean };
  getMember(userId: string): Member | null;
  getMembersWithMembership(membership: "ban"): Member[];
};

/** The slice of MatrixClient this needs. */
export type BanSyncClient = {
  ban(roomId: string, userId: string, reason?: string): Promise<unknown>;
  unban(roomId: string, userId: string): Promise<unknown>;
};

/**
 * Per room the viewer may ban in: the site-banned accounts not banned there yet, and — only when
 * `complete` — the room bans this sync made whose site ban has ended. An unban is computed from
 * ABSENCE in the list, so a list that may be partial (an error, a cut-off page) must lift nothing:
 * bans are still applied, unbans wait for a whole list. Never the viewer; never someone at or
 * above the viewer's own power (the homeserver would refuse it).
 * @test-only useSiteBanSync below runs it; the test pins the plan without React.
 */
export function siteBanPlan(rooms: BanSyncRoom[], bannedIds: string[], viewerId: string, complete: boolean): { roomId: string; ban: string[]; unban: string[] }[] {
  const banned = new Set(bannedIds.filter((id) => id && id !== viewerId));
  const plan: { roomId: string; ban: string[]; unban: string[] }[] = [];
  for (const room of rooms) {
    const me = room.getMember(viewerId);
    if (!me || !room.currentState.hasSufficientPowerLevelFor("ban", me.powerLevel)) continue;
    const ban = [...banned].filter((id) => {
      const m = room.getMember(id);
      return m?.membership !== "ban" && (m?.powerLevel ?? 0) < me.powerLevel;
    });
    const unban = !complete ? [] : room.getMembersWithMembership("ban")
      .filter((m) => !banned.has(m.userId) && m.events?.member?.getContent().reason === SITE_BAN_REASON)
      .map((m) => m.userId);
    if (ban.length || unban.length) plan.push({ roomId: room.roomId, ban, unban });
  }
  return plan;
}

/** Apply a plan, one write at a time; one refused write never stops the rest.
 *  @test-only useSiteBanSync below runs it; the test pins the client call shape. */
export async function runSiteBanPlan(client: BanSyncClient, plan: { roomId: string; ban: string[]; unban: string[] }[], sleep?: (ms: number) => Promise<void>): Promise<void> {
  for (const { roomId, ban, unban } of plan) {
    for (const id of ban) {
      const r = await attemptWithRetry(() => client.ban(roomId, id, SITE_BAN_REASON).then(() => undefined), undefined, sleep);
      if (r.status === "failed") console.warn("[Matrix] site ban sync: ban failed", roomId, r.error);
    }
    for (const id of unban) {
      const r = await attemptWithRetry(() => client.unban(roomId, id).then(() => undefined), undefined, sleep);
      if (r.status === "failed") console.warn("[Matrix] site ban sync: unban failed", roomId, r.error);
    }
  }
}

/** Every account with an active site ban or timeout, from the sync's own unlimited route, and
 *  whether the list is known to be whole (`complete: true` from the route — nothing else counts).
 *  Null when this viewer may not read it (not a mod) or the server did not answer: nothing then.
 *  @test-only useSiteBanSync below calls it; the test pins that a partial list lifts nothing. */
export async function activeSiteBans(): Promise<{ ids: string[]; complete: boolean } | null> {
  try {
    const res = await fetch("/api/mod/bans/active", { cache: "no-store" });
    if (!res.ok) return null;
    const d = (await res.json()) as { matrixIds?: unknown; complete?: unknown };
    if (!Array.isArray(d.matrixIds)) return null;
    const ids = d.matrixIds.filter((id): id is string => typeof id === "string" && id.startsWith("@"));
    return { ids, complete: d.complete === true && ids.length === d.matrixIds.length };
  } catch {
    return null;
  }
}

export function useSiteBanSync(client: BanSyncClient | null | undefined, rooms: BanSyncRoom[], myUserId: string): void {
  const running = useRef(false);
  useEffect(() => {
    if (!client || rooms.length === 0 || !myUserId) return;
    const run = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const list = await activeSiteBans();
        if (list) await runSiteBanPlan(client, siteBanPlan(rooms, list.ids, myUserId, list.complete));
      } finally {
        running.current = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), EVERY_MS);
    const onChange = () => void run();
    window.addEventListener(SITE_BANS_CHANGED, onChange);
    return () => { clearInterval(timer); window.removeEventListener(SITE_BANS_CHANGED, onChange); };
  }, [client, rooms, myUserId]);
}
