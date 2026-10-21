// Admin Panel → Platforms → Discord leads with what is true on this install: the Discord bridge is
// not part of the bundle, and the two values on the page only describe a bridge run beside the
// community server. With neither value set there is no bridge, and the page says so before anything
// else — never a page that reads as if Discord were connected.

import type { InstanceView } from "@/app/lib/instanceAdminView";
import { card, h2 } from "./parts";

/** The values a Discord bridge sets; unset everywhere = this install has no bridge. */
const BRIDGE_KEYS = ["discordBridge.usernameTemplate", "discordBridge.displaynameTemplate"] as const;

/** Whether this install describes a Discord bridge (either template set where the site reads it). */
function discordBridgePresent(view: Pick<InstanceView, "keys">): boolean {
  return view.keys.some((k) => (BRIDGE_KEYS as readonly string[]).includes(k.key)
    && k.packages.some((p) => typeof p.display === "string" && p.display.trim() !== ""));
}

export default function DiscordNote({ view }: { view: Pick<InstanceView, "keys"> }) {
  if (discordBridgePresent(view)) return null;
  return (
    <section className={`${card} space-y-1`} data-discord-note="absent">
      <h2 className={h2}>The Discord bridge is not part of this install</h2>
      <p className="text-xs text-secondary">
        Nothing here connects to Discord. A Discord bridge (mautrix-discord) run beside the community server links a
        Discord server&apos;s channels to the community&apos;s rooms; the two values below only tell the site how that
        bridge names Discord people. Without a bridge, leave them unset.
      </p>
    </section>
  );
}
