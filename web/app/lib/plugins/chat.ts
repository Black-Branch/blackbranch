// The chat's plugin contributions — read from the install's plugin through `@owner/chat`
// (app/(owner)/chat.ts, or ./absent/chat.ts with no owner folder).
import { chatConsole } from "@owner/chat";
import type { ChatConsole } from "./types.ts";

/** The console beside the chat box, or null (then command output stays in the notice line). */
export const CHAT_CONSOLE: ChatConsole | null = chatConsole;
