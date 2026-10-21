// The ONE place web reads the install's site plugin.
//
// `@owner/plugin` is resolved by the build: app/(owner)/plugin.ts when the owner folder exists,
// else ./absent/plugin.ts (next.config.ts resolveAlias; tsconfig.json `@owner/*` paths, tried in order). No other
// file may import the owner folder — tools/check-owner-seam.mjs fails the build if one does.
// node --test cannot resolve the alias, so tests import the helpers' pure halves, not this file.
import { ownerPlugin } from "@owner/plugin";
import { instanceEntry, MODULES } from "../instanceSchema.generated.mjs";
import type { MessageScore, PluginPrivacy, WebPlugin } from "./types.ts";
import { moduleKeyInstalled } from "./moduleKeys.ts";

const plugin: WebPlugin | null = ownerPlugin;

/** Whether a settings key belongs to a module this install has (plugin-provided modules need the plugin). */
export function keyInstalled(key: string): boolean {
  return moduleKeyInstalled(instanceEntry(key)?.module ?? null, MODULES, plugin);
}

/** Whether this build carries a site plugin. A build without it is a public install (the
 *  viewer "link YouTube" button exists only on a site with the plugin). */
export function ownerPluginInstalled(): boolean {
  return plugin !== null;
}

/** What the plugin adds to the privacy policy — null without a plugin that declares it. */
export function pluginPrivacy(): PluginPrivacy | null {
  return plugin?.privacy ?? null;
}

/** The per-message scores this install computes — none without a plugin that declares them. */
export function messageScores(): readonly MessageScore[] {
  return plugin?.messageScores ?? [];
}
