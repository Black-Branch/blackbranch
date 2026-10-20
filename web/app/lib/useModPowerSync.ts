"use client";

// Grant every site mod power 50 in every community channel, and take it back from a
// former mod, from the owner's own client.
//
// Why here and not on the server: writing m.room.power_levels needs power 100,
// which only the room creator has — a server-side job would need a standing
// owner-grade Matrix credential on the server, or a service account
// bootstrapped into every room first. Neither is worth it for a promotion that
// happens a few times a year. The cost of this choice: a mod promoted while the
// owner is away gets their power at the owner's next visit.

import { useEffect, useRef } from "react";
import { modPowerPlan, modDemotePlan, MOD_POWER, type DemoteRoom } from "./modPowerPlan.ts";
import { attemptWithRetry } from "./matrixModerate.ts";

// `undefined` removes the user's entry, so they fall back to the room's default level.
type PowerClient = { setPowerLevel(roomId: string, userId: string[], level: number | undefined): Promise<unknown> };

/**
 * Apply one plan, room by room. Each room is its own `attemptWithRetry` call
 * (rate-limit aware, one retry), so a room that fails — throttled twice, or
 * refused outright — never stops the rooms after it. On this deploy's first
 * run every channel needs a write; abandoning the loop at the first throttle
 * would leave some mods with power in some channels and not others, the exact
 * half-broken state this feature exists to prevent.
 *
 * @test-only the only call site is useModPowerSync below, in the same file —
 * check-orphans' cross-file reference scan can't see that wiring (it excludes
 * a symbol's own defining file). The export exists for
 * useModPowerSync.test.ts, which pins the retry/continue behaviour directly
 * rather than only through the hook's effect timing and fetch mocking.
 */
export async function runModPowerPlan(
  client: PowerClient,
  plan: { roomId: string; userIds: string[] }[],
  sleep?: (ms: number) => Promise<void>,
  level: number | null = MOD_POWER
): Promise<void> {
  for (const { roomId, userIds } of plan) {
    const result = await attemptWithRetry(
      () => client.setPowerLevel(roomId, userIds, level ?? undefined).then(() => undefined),
      undefined,
      sleep
    );
    if (result.status === "failed") {
      // Once per room, never a banner: nobody can act on it but us.
      console.warn("[Matrix] mod power sync failed", roomId, result.error);
    }
  }
}

export function useModPowerSync(
  client: PowerClient | null | undefined,
  rooms: DemoteRoom[],
  myUserId: string
): void {
  const ran = useRef(false);
  useEffect(() => {
    if (!client || ran.current || rooms.length === 0 || !myUserId) return;
    ran.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/community/mods");
        // 403 is the ordinary answer for everyone who is not an admin.
        if (!res.ok) return;
        const answer = (await res.json()) as { modIds?: string[]; keepIds?: unknown };
        const modIds = answer.modIds;
        const keepIds = Array.isArray(answer.keepIds) ? answer.keepIds.filter((id): id is string => typeof id === "string") : [];
        // No list, no reconcile: an empty or missing answer must never read as "nobody is a mod".
        if (!Array.isArray(modIds) || modIds.length === 0) return;
        await runModPowerPlan(client, modPowerPlan(rooms, modIds, myUserId));
        // Anyone else at mod level goes back to the room default (null: their entry is dropped) —
        // except the install's own accounts and the room's bridge bots (modDemotePlan).
        await runModPowerPlan(client, modDemotePlan(rooms, modIds, myUserId, MOD_POWER, keepIds), undefined, null);
      } catch (e) {
        // The plan fetch itself failed — nothing to loop over.
        console.warn("[Matrix] mod power sync failed", e);
      }
    })();
  }, [client, rooms, myUserId]);
}
