import { useEffect, useState } from "react";
import { onChatNotice } from "./chatNotice.ts";

// The latest chat notice (chatNotice.ts), for a host with NO composer to say it
// in: the /chat window, and the chat column when the viewer is signed out or
// timed out. Clears itself after five seconds, as the composer's line does.
export function useChatNoticeText(): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onChatNotice((t) => {
      setText(t);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setText(null), 5000);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);
  return text;
}
