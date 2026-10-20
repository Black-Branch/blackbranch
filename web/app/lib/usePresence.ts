"use client";

import { useEffect, useState } from "react";
import type { Room } from "matrix-js-sdk";
import { getJson } from "./http";
import type { PresenceDirectory, SitePresenceRow, MatrixSnapshot } from "./presenceState";

// One shared poller for GET /api/presence: 30 s while at least one consumer
// is mounted, stopped when the last one leaves. Module-level like
// useCoinHeartbeat's `beatNow` — every members list / member card on the page
// reads the same answer, and the route is hit once per tick, not once per row.

const POLL_MS = 30_000;
let current: PresenceDirectory | null = null;
const listeners = new Set<(d: PresenceDirectory | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  getJson<PresenceDirectory>("/api/presence", { cache: "no-store" })
    .then((d) => { current = d; listeners.forEach((l) => l(d)); })
    .catch(() => { /* keep the last answer — a blip must not blank the list */ });
}

export function usePresence(): PresenceDirectory | null {
  const [dir, setDir] = useState<PresenceDirectory | null>(current);
  useEffect(() => {
    listeners.add(setDir);
    if (timer === null) {
      timer = setInterval(tick, POLL_MS);
      // First answer as soon as possible; deferred so the setState it causes
      // lands outside the effect pass (react-hooks/set-state-in-effect).
      Promise.resolve().then(tick);
    }
    return () => {
      listeners.delete(setDir);
      if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
    };
  }, []);
  return dir;
}

export function presenceOf(dir: PresenceDirectory | null, userId: string): SitePresenceRow | null {
  return dir?.users[userId] ?? null;
}

/** What the community client knows from m.presence. lastActiveTs is derived
 *  from the SDK's lastPresenceTs − lastActiveAgo (the event carries an "ago",
 *  the SDK stamps when it arrived). */
export function matrixSnapshotOf(room: Room, userId: string): MatrixSnapshot | null {
  const u = room.client.getUser(userId);
  if (!u) return null;
  const lastActiveTs = u.lastPresenceTs ? u.lastPresenceTs - (u.lastActiveAgo || 0) : null;
  return { presence: u.presence ?? null, lastActiveTs };
}
