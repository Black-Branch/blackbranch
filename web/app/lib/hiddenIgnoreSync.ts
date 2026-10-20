// Behavior — keeps the account's Matrix ignore list (m.ignored_user_list)
// in step with the hidden-people list,
// so Community — and Element, on any device — hides the same site accounts.
//
// Same ownership rule as ignoredBots.ts: what the SITE added is recorded in
// account data (HIDDEN_PEOPLE, matrixNamespace.ts), and only those ids are ever removed. Someone the
// viewer ignored themselves (in Element) is never claimed, so unhiding them here
// leaves their own ignore alone.
// Pure over a client stub, so node --test drives it.

import { withIgnoreListLock, readAddedIds } from "./ignoredBots.ts";
import { HIDDEN_PEOPLE } from "./matrixNamespace.ts";

export type HideSyncClient = {
  getIgnoredUsers(): string[];
  setIgnoredUsers(ids: string[]): Promise<unknown>;
  getAccountData(type: string): { getContent(): Record<string, unknown> } | undefined;
  setAccountData(type: string, content: Record<string, unknown>): Promise<unknown>;
};

export function syncHiddenToIgnore(client: HideSyncClient, hiddenMatrixIds: readonly string[]): Promise<void> {
  // Queued behind any other ignore-list write (ignoredBots.ts) — both rewrite the whole list.
  return withIgnoreListLock(() => syncNow(client, hiddenMatrixIds));
}

async function syncNow(client: HideSyncClient, hiddenMatrixIds: readonly string[]): Promise<void> {
  const want = new Set(hiddenMatrixIds);
  const current = new Set(client.getIgnoredUsers());
  const prevAdded = new Set(readAddedIds(client, HIDDEN_PEOPLE));
  const toAdd = [...want].filter((id) => !current.has(id));
  const toRemove = [...prevAdded].filter((id) => !want.has(id) && current.has(id));
  const added = [...new Set([...[...prevAdded].filter((id) => want.has(id)), ...toAdd])].sort();
  if (toAdd.length || toRemove.length) {
    const next = [...current].filter((id) => !toRemove.includes(id)).concat(toAdd);
    await client.setIgnoredUsers(next);
  }
  if (added.join() !== [...prevAdded].sort().join()) await client.setAccountData(HIDDEN_PEOPLE.write, { added });
}
