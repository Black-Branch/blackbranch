// Pure: the Admin Panel tab each setup list is shown on.

/** Where each setup list (config/modules.mjs `setup`, config/setup-core.mjs) is shown as a guide
 *  above its keys' cards — the setup pages' words and the panel's are one list.
 *  `list` is `module:<id>` or `core:<id>`; adminLayout.test.ts holds every list here once and every
 *  step's fields in a card of the same tab. */
export const SETUP_GUIDES: readonly { section: string; sub: string; list: string }[] = [
  { section: "utility", sub: "obs", list: "module:obs" },
  { section: "payments", sub: "connections", list: "module:stripe" },
  { section: "payments", sub: "connections", list: "module:paypal" },
  { section: "payments", sub: "connections", list: "core:donations" },
  { section: "platforms", sub: "youtube", list: "module:youtube" },
  { section: "platforms", sub: "twitch", list: "core:twitch" },
  { section: "platforms", sub: "kick", list: "core:kick" },
  { section: "platforms", sub: "streamplace", list: "core:streamplace" },
  { section: "utility", sub: "tts", list: "core:voice" },
];

