// The live answer of viewerLinkPolicy for this install. SERVER ONLY (it reads the owner seam).
import { ownerPluginInstalled } from "./plugins/installed";
import { instanceBool } from "./instanceConfigServer";
import { viewerLinkAllowed } from "./viewerLinkPolicy";

export function viewerMayLink(platform: string): boolean {
  return viewerLinkAllowed(platform, { ownerPlugin: ownerPluginInstalled(), youtubeOn: instanceBool("modules.youtube") });
}
