// The runners behind the plugin's commands (./commands.ts), keyed by their leaves' `run` keys —
// read through `@owner/commandRunners` (app/(owner)/commandRunners.ts, or ./absent/commandRunners.ts).
// Its own area so the command TREE stays loadable without the runners' client code.
import { chatCommandRunners } from "@owner/commandRunners";
import type { PluginHandlerKey } from "../commands/spec.ts";
import type { ChatCommandRunner } from "./types.ts";

/** The runner for a plugin command leaf, or null when no plugin provides it. */
export function pluginCommandRunner(key: PluginHandlerKey): ChatCommandRunner | null {
  return chatCommandRunners[key] ?? null;
}
