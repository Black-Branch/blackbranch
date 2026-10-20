"use client";

import { ChatsCircle } from "@phosphor-icons/react/dist/ssr";
import { Window } from "@/app/components/chrome";
import ChatHistorySection from "./sections/ChatHistorySection";

/** Where the Chat history's own pop-out lives. */
const CHAT_HISTORY_URL = "/mod/chat";

/** Opens the Chat history in its own browser window — the same name the window chrome's pop-out
 *  uses, so a second press brings the open one forward instead of opening another. */
export function popOutChatHistory(): void {
  window.open(CHAT_HISTORY_URL, `bb-panel-${CHAT_HISTORY_URL}`, "popup=yes,width=760,height=820");
}

// The Chat history on its own: the window chrome every panel uses, as a
// page — the /mod/chat pop-out a mod keeps beside the stream. The list takes the window's height.
export default function ChatHistoryWindow({ onClose }: { onClose: () => void }) {
  return (
    <Window
      presentation="page"
      kind="task"
      name="Chat history"
      mark={<ChatsCircle size={14} weight="bold" />}
      title="Chat history"
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col p-3">
        <ChatHistorySection popout />
      </div>
    </Window>
  );
}
