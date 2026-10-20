// The Admin Panel's setup guides: every setup list, computed for this install (paste values from
// its own addresses) with its module switch. SERVER ONLY. The panel shows each above its keys'
// cards (adminLayout.ts SETUP_GUIDES); the setup pages show the same lists (setupPages.ts).

import { installValue } from "../installValues";
import { instanceBool } from "../instanceConfigServer";
import { moduleSetupPage, coreSetupPage, type SetupPage } from "./setupPages";
import { ownerPluginInstalled } from "../plugins/installed";

export type SetupGuide = { list: string; page: SetupPage | null; on: boolean | null };

export function adminSetupGuides(lists: readonly string[]): SetupGuide[] {
  const a = {
    origin: installValue("site.origin"), apiOrigin: installValue("site.apiOrigin"),
    matrixOrigin: installValue("matrix.baseUrl"), serverName: installValue("matrix.serverName"),
  };
  return lists.map((list) => {
    const [kind, id = ""] = list.split(":");
    if (kind === "module") return { list, page: moduleSetupPage(id, a, { ownerPlugin: ownerPluginInstalled() }), on: instanceBool(`modules.${id}`) };
    return { list, page: coreSetupPage(id, a), on: null };
  });
}
