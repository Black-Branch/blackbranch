// Pure: the Admin Panel tab each setup list is shown on.

/** Where each setup list (config/modules.mjs `setup`, config/setup-core.mjs) is shown as a guide
 *  above its keys' cards — the setup pages' words and the panel's are one list.
 *  `list` is `module:<id>` or `core:<id>`; adminLayout.test.ts holds every list here once and every
 *  step's fields in a card of the same tab. `place` is the tab in words, as the Doctor names it
 *  (doctorSkipped.ts); doctorSetup.test.ts holds each to a rail place. */
export const SETUP_GUIDES: readonly { section: string; sub: string; list: string; place: string }[] = [
  { section: "utility", sub: "obs", list: "module:obs", place: "Utility → OBS" },
  { section: "payments", sub: "connections", list: "module:stripe", place: "Payments → Connections" },
  { section: "payments", sub: "connections", list: "module:paypal", place: "Payments → Connections" },
  { section: "payments", sub: "connections", list: "core:donations", place: "Payments → Connections" },
  { section: "platforms", sub: "youtube", list: "module:youtube", place: "Platforms → YouTube" },
  { section: "platforms", sub: "twitch", list: "core:twitch", place: "Platforms → Twitch" },
  { section: "platforms", sub: "kick", list: "core:kick", place: "Platforms → Kick" },
  { section: "platforms", sub: "streamplace", list: "core:streamplace", place: "Platforms → Streamplace" },
  { section: "utility", sub: "tts", list: "core:voice", place: "Utility → TTS" },
  // Shown inside the page's own bot step (DiscordBotStep), not above key cards: the page has none.
  { section: "site", sub: "discord", list: "core:discord", place: "Site → Discord" },
];
