"use client";

import { useSyncExternalStore } from "react";
import { userStyleStore, type UserLooks } from "@/app/lib/userStyleStore";

export type { UserLook, UserLooks } from "@/app/lib/userStyleStore";

const EMPTY: UserLooks = {};

// Name style + pronouns keyed by matrix_id (/api/users/looks) — what lets the Community timeline
// obey the chat's Name styles and Pronoun symbols switches. Filled for the ids asked for with
// useWantUserStyles (useUserColors.ts), which fetches both maps together.
export function useUserLooks(): UserLooks {
  return useSyncExternalStore(userStyleStore.subscribe, userStyleStore.looks, () => EMPTY);
}
