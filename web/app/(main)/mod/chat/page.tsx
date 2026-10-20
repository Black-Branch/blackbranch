import { redirect } from "next/navigation";
import { isModUser } from "@/app/lib/admin";
import { siteName } from "@/app/lib/siteName";
import ChatHistoryPopout from "./ChatHistoryPopout";

export const metadata = { title: `Chat history · ${siteName()}` };

// The Chat history's own pop-out. Mods only — checked here on the server,
// and again by /api/mod/chat-history and /api/mod/log.
export default async function ChatHistoryPage() {
  if (!(await isModUser())) redirect("/");
  return <ChatHistoryPopout />;
}
