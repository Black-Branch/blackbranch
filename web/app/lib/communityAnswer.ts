"use client";

import { useEffect, useState } from "react";
import type { RoleRow } from "./community/desired";
import type { MemberLadder } from "./memberGroups";

// The community client's one read of GET /api/community/mods (route: app/lib/community/modsAnswer.ts).
// Every field is optional on the wire: an older server sent only modIds and keepIds, and a member
// who is not an admin gets no modIds at all.

export type CommunityAnswer = {
  /** null when the answer has no mod list (a member, not an admin) — never [], which would read as "nobody is a mod". */
  modIds: string[] | null;
  keepIds: string[];
  hubRoomId: string | null;
  hiddenIds: string[];
  roles: RoleRow[];
  staffIds: string[];
  botIds: string[];
};

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function role(v: unknown): RoleRow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.label !== "string" || typeof r.level !== "number" || !Number.isFinite(r.level)) return null;
  return {
    key: r.key, label: r.label, level: r.level,
    colour: typeof r.colour === "string" ? r.colour : null,
    hoist: r.hoist !== false,
    orderKey: typeof r.orderKey === "string" ? r.orderKey : "",
    builtin: r.builtin === true,
  };
}

/** The wire answer, field by field, with an older server's gaps filled.
 *  @test-only exported for its own tests; fetchCommunityAnswer is the caller */
export function parseCommunityAnswer(raw: unknown): CommunityAnswer {
  const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    modIds: Array.isArray(a.modIds) ? ids(a.modIds) : null,
    keepIds: ids(a.keepIds),
    hubRoomId: typeof a.hubRoomId === "string" && a.hubRoomId ? a.hubRoomId : null,
    hiddenIds: ids(a.hiddenIds),
    roles: Array.isArray(a.roles) ? a.roles.map(role).filter((r): r is RoleRow => r !== null) : [],
    staffIds: ids(a.staffIds),
    botIds: ids(a.botIds),
  };
}

let pending: Promise<CommunityAnswer | null> | null = null;
/** The kept answer, for a list that opens after it arrived (the bootstrap asks first): no flash of the hidden accounts. */
let settled: CommunityAnswer | null = null;

/** One fetch per page once it has an answer. A refusal or a failure is not kept, so the next
 *  caller asks again. */
export function fetchCommunityAnswer(): Promise<CommunityAnswer | null> {
  if (!pending) {
    const p: Promise<CommunityAnswer | null> = fetch("/api/community/mods")
      .then(async (res) => (res.ok ? parseCommunityAnswer(await res.json()) : null))
      .catch(() => null)
      .then((answer) => {
        if (!answer && pending === p) pending = null;
        if (answer) settled = answer;
        return answer;
      });
    pending = p;
  }
  return pending;
}

const NO_LADDER: MemberLadder = { roles: [], staffIds: [], botIds: [], hiddenIds: [] };
const ladderOf = (a: CommunityAnswer | null): MemberLadder =>
  a ? { roles: a.roles, staffIds: a.staffIds, botIds: a.botIds, hiddenIds: a.hiddenIds } : NO_LADDER;

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask until an answer arrives, waiting 1 s, 2 s, 4 s … (at most a minute) between failures, and
 *  hand it over once. Until then the list knows nobody to hide, so a failure at load must not be the
 *  last word. Returns stop.
 *  @test-only exported so its tests can drive the waits; useCommunityLadder in this file is the caller */
export function watchCommunityAnswer(
  onAnswer: (a: CommunityAnswer) => void,
  deps: { load?: () => Promise<CommunityAnswer | null>; wait?: (ms: number) => Promise<void> } = {},
): () => void {
  const load = deps.load ?? fetchCommunityAnswer;
  const wait = deps.wait ?? sleep;
  let live = true;
  void (async () => {
    for (let delay = FIRST_RETRY_MS; live; delay = Math.min(delay * 2, MAX_RETRY_MS)) {
      const a = await load();
      if (!live) return;
      if (a) { onAnswer(a); return; }
      await wait(delay);
    }
  })();
  return () => { live = false; };
}

/** The ladder for the members list; the default ladder until (or unless) the server answers. */
export function useCommunityLadder(): MemberLadder {
  const [ladder, setLadder] = useState<MemberLadder>(() => ladderOf(settled));
  useEffect(() => watchCommunityAnswer((a) => setLadder(ladderOf(a))), []);
  return ladder;
}
