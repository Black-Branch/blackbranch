// The Discord page's Bot and Import routes, wired to this process: the pool, the host's drop box (the
// bot token and every read of Discord are the host's, through the bridge), the reconciler switch.
// SERVER ONLY. The handlers are discordImportAdmin.ts.
import pool from "@/lib/db";
import { dropDiscordToken, hostFile, hostRequestsAvailable, hostResult, requestHost } from "../hostRequests";
import { instanceBool } from "../instanceConfigServer";
import { retentionCapDays } from "./communityAdminServer";
import type { ImportDeps } from "./discordImportAdmin";

export function discordImportDeps(admin?: string): ImportDeps {
  return {
    pool, admin,
    canCall: hostRequestsAvailable(),
    askHost: (verb) => requestHost(verb),
    hostAnswer: (verb) => hostResult(verb),
    hostFile: (name) => hostFile(name),
    dropToken: (token) => dropDiscordToken(token),
    reconcile: instanceBool("community.reconciler") ? () => requestHost("community-reconcile") : null,
    retentionCapDays,
  };
}
