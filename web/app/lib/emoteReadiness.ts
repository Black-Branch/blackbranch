// The emote subsystem's readiness registrant: the site catalog (7tv + site
// emotes) and the signed-in user's own
// Twitch set. One module because two hooks report into it — useEmotes.ts and
// usePersonalEmotes.ts each own one stage — and the community pane composes
// this key after the client's (MatrixView.tsx COMMUNITY_BOOT).
// `.ts` extension required here — this module is exercised under
// `node --test` (emoteReadiness.render.test.ts), which cannot resolve
// extensionless TypeScript specifiers (same rule as useSendDestination.ts).
import { registerReadiness } from "./readiness.ts";

export const EMOTES_READINESS_KEY = "emotes";
export const emoteReadiness = registerReadiness(EMOTES_READINESS_KEY, [
  { id: "catalog", label: "Loading emotes" },
  { id: "personal", label: "Loading your emotes" },
]);
