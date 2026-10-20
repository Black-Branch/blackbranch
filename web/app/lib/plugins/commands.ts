// The site command tree's plugin commands — read from the install's plugin through
// `@owner/commands` (app/(owner)/commands.ts, or ./absent/commands.ts). Pure data, so the server
// side (the terminal's usage names) can read the tree without the runners; those are their own
// area, ./commandRunners.ts. (Typed by the area file — the tree, app/lib/commands/spec.ts, imports
// this one, so naming its CommandNode here would close a loop.)
import { chatCommands } from "@owner/commands";

/** The plugin's top-level commands, in order (none without a plugin). */
export const PLUGIN_COMMANDS = chatCommands;
