"use client";
// ⑤ Behavior half B: whenever the hidden list changes, bring the account's Matrix
// ignore list in step (hiddenIgnoreSync.ts owns the rules). Mounted once, by the
// site chat. Signed out or no Matrix client: nothing to do.
import { useEffect } from "react";
import { useMatrixClient } from "./MatrixClientContext";
import { useBehaviorLists, accountListsLoaded } from "./behaviorStore";
import { syncHiddenToIgnore, type HideSyncClient } from "./hiddenIgnoreSync";

export function useHiddenIgnoreSync(): void {
  const { client, status } = useMatrixClient();
  const lists = useBehaviorLists();
  useEffect(() => {
    if (!client || status !== "ready" || !accountListsLoaded()) return;
    const ids = lists.hidden.map((h) => h.matrixId).filter((x): x is string => !!x);
    syncHiddenToIgnore(client as unknown as HideSyncClient, ids)
      .catch((e) => console.warn("[behavior] ignore-list sync failed", e));
  }, [client, status, lists]);
}
