import type { PluginHandlerKey } from "../../commands/spec.ts";
import type { ChatCommandRunner } from "../types.ts";

// What @owner/commandRunners resolves to when this install has no owner folder: no plugin command runners.
export const chatCommandRunners: Readonly<Record<PluginHandlerKey, ChatCommandRunner>> = {};
