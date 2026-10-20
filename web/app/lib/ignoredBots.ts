// Bridged Discord bots (FixTweet, for one) duplicate what the site already shows:
// the user's link gets a card here, so the bot's reply is noise. Ignoring them
// with the account's m.ignored_user_list makes Synapse drop their events from
// /sync and from unread counts — for every client on the account, Element
// included — which is exactly what that account-data event exists for.
//
// Additive only, and one-shot per bot per account. A user may have ignored
// someone in another client, so this never removes an entry — but a user who
// UN-ignores a bot in another client (Element) must have that stick, so the
// site also never re-adds an id it has already added once. What the site
// itself added lives in account data (IGNORED_BOTS, cross-device) as the record
// of intent; the live ignore list is not that record, because the user (or
// another client) is allowed to edit it out from under us.

import { isBridgedBot } from "./discordSender.ts";
import { HIDDEN_PEOPLE, IGNORED_BOTS, readFirst, type NamespacedName } from "./matrixNamespace.ts";

type AccountDataReader = { getAccountData(type: string): { getContent(): Record<string, unknown> } | undefined };

/** The ids recorded under one of the site's "added" account-data types: the product name's
 *  record when it has one, else the legacy one's (read both names). A record without an
 *  `added` array is no record. */
export function readAddedIds(client: AccountDataReader, name: NamespacedName): string[] {
  const added = readFirst(name, (t) => {
    const a = client.getAccountData(t)?.getContent()?.added;
    return Array.isArray(a) ? a : undefined;
  });
  return (added ?? []).filter((x): x is string => typeof x === "string");
}

/** The slice of MatrixClient this needs, so the unit test runs on a stub. A
 *  member's rawDisplayName is the profile name; `name` is the SDK's
 *  disambiguated one ("X (@id)") and would hide the bridge's trailing marker. */
export type IgnoreClient = {
  getRooms(): Array<{
    getMyMembership(): string;
    loadMembersIfNeeded(): Promise<unknown>;
    getJoinedMembers(): Array<{ userId: string; rawDisplayName: string }>;
  }>;
  getIgnoredUsers(): string[];
  setIgnoredUsers(userIds: string[]): Promise<unknown>;
  getAccountData(type: string): { getContent(): Record<string, unknown> } | undefined;
  setAccountData(type: string, content: Record<string, unknown>): Promise<unknown>;
};

async function bridgedBotIds(client: IgnoreClient): Promise<string[]> {
  const ids = new Set<string>();
  // The client starts with lazyLoadMembers: true, so a room's member list can
  // be partial until this resolves — a bot that hasn't spoken in the synced
  // window would otherwise be missed until the next client start. The loads
  // race the initial sync, so they run together rather than one room at a
  // time. Best-effort: a failed load just falls back to whatever's in the store.
  const joined = client.getRooms().filter((room) => room.getMyMembership() === "join");
  await Promise.all(joined.map((room) => room.loadMembersIfNeeded().catch(() => {})));
  for (const room of joined) {
    for (const m of room.getJoinedMembers()) if (isBridgedBot(m.rawDisplayName, m.userId)) ids.add(m.userId);
  }
  return [...ids].sort();
}

/** Add every bridged bot in the joined rooms to the ignore list, but only ids
 *  the site has never added before — an id it added once and the user then
 *  un-ignored (in Element, say) is never re-added. Returns the ids added
 *  (empty when nothing changed, in which case the ignore list was not written;
 *  the lazy copy below may still write the site's own record).
 *  Loads each joined room's members first (see bridgedBotIds) because the
 *  client runs with lazyLoadMembers: true; `stillValid` is checked right after
 *  that await and before any write, so a client torn down (sign-out) during
 *  the member load does not write on its way out. */
// ONE queue for every read-modify-write of m.ignored_user_list. Two writers exist
// (this bot sync and the Behavior hide sync, hiddenIgnoreSync.ts); each reads the
// whole list and writes the whole list back, so run concurrently one would erase
// the other's addition.
let ignoreChain: Promise<unknown> = Promise.resolve();
export function withIgnoreListLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ignoreChain.then(fn, fn);
  ignoreChain = run.catch(() => {});
  return run;
}

/** The account-data lazy copy (write the product name). For each of the site's "added" records:
 *  when the product name holds no record (no `added` array) and the legacy name does, write the
 *  product name with the same content. The legacy record is KEPT — readers fall back to it until
 *  the counts tool shows its legacy-only count near 0. Only the user's own client can write their
 *  account data (no admin credential can), so this runs on client start, inside the ignore-list
 *  queue, from syncIgnoredBots. A fresh install (no legacy prefix) has nothing to copy. */
async function copyAddedRecordsForward(client: Pick<IgnoreClient, "getAccountData" | "setAccountData">): Promise<void> {
  for (const name of [IGNORED_BOTS, HIDDEN_PEOPLE]) {
    const legacy = name.read[1];
    if (!legacy) continue;
    if (Array.isArray(client.getAccountData(name.write)?.getContent()?.added)) continue;
    const old = client.getAccountData(legacy)?.getContent();
    if (!old || !Array.isArray(old.added)) continue;
    await client.setAccountData(name.write, { ...old });
  }
}

export async function syncIgnoredBots(client: IgnoreClient, stillValid: () => boolean = () => true): Promise<string[]> {
  const bots = await bridgedBotIds(client);
  if (!stillValid()) return [];
  return withIgnoreListLock(async () => {
  if (!stillValid()) return [];
  // First, every client start: carry a legacy-only "added" record forward.
  await copyAddedRecordsForward(client);
  const current = new Set(client.getIgnoredUsers());
  const previouslyAdded = new Set(readAddedIds(client, IGNORED_BOTS));
  const added = bots.filter((id) => !current.has(id) && !previouslyAdded.has(id));
  if (added.length === 0) return [];
  await client.setIgnoredUsers([...current, ...added]);
  await client.setAccountData(IGNORED_BOTS.write, { added: [...previouslyAdded, ...added] });
  return added;
  });
}

/** The slice of a Room the list predicates need: the SDK's Room carries its
 *  client. Optional all the way down so a test fake or a pre-boot room (no
 *  client yet) filters nothing instead of throwing. */
export type IgnoreRoom = { client?: { isUserIgnored?(userId: string): boolean } | null };

/** Whether `userId` is on the account's ignore list, for this room's client.
 *  `isIgnoredSender` (below) wraps an event through this; useTyping.ts (the
 *  typing-line predicate) calls it directly
 *  with a bare user id, since a typing notification has no event to wrap. */
export function isIgnoredUser(room: IgnoreRoom, userId: string): boolean {
  return room.client?.isUserIgnored?.(userId) === true;
}

/** True when the event's sender is on the account's m.ignored_user_list —
 *  Synapse drops such senders from future syncs, but the store keeps what
 *  arrived before the list was written, so every list re-applies the rule. */
export function isIgnoredSender(room: IgnoreRoom, ev: { getSender(): string | undefined }): boolean {
  return isIgnoredUser(room, ev.getSender() ?? "");
}
