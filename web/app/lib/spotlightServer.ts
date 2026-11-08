// The streamer's highlight switch as this process holds it now (spotlightSwitch.ts). SERVER ONLY.
// Read at call time, so a change applies at the next click.
import { instanceBool } from "./instanceConfigServer.ts";
import { streamApiFetch } from "./streamApi";
import { SPOTLIGHT_OFF_KEY, takesDownSpotlight } from "./spotlightSwitch.ts";

/** True = the highlight is switched off for everyone. */
export function spotlightOff(): boolean {
  return instanceBool(SPOTLIGHT_OFF_KEY);
}

/** Run after an instance key was saved or cleared (and the config reloaded): switching the
 *  highlight off takes down the pick showing now. stream-api holds it in memory and replays it to
 *  every client that connects, so leaving it would keep reaching new viewers. Best-effort: a
 *  stream-api that is down holds no pick to take down. */
export async function afterSpotlightSave(key: string): Promise<void> {
  if (takesDownSpotlight(key, spotlightOff())) {
    await streamApiFetch("/chat/spotlight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spotlight: null }),
    }).catch(() => null);
  }
}
