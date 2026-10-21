"use client";

import { useRef } from "react";
import { ChatSidebar } from "@/app/features/chat";
import { ErrorBoundary } from "./ErrorBoundary";
import { useKeyboardLift } from "@/app/lib/useKeyboardLift";
import type { ChatMsg } from "@/app/lib/chatMsg";
import type { EmoteMap } from "@/app/lib/emoteMap";

export default function PopoutView({
  isSignedIn,
  userId,
  canonicalId,
  isMod,
  isAdmin = false,
  initialMessages,
  initialEmotes,
}: {
  isSignedIn: boolean;
  userId: string | null;
  canonicalId?: string | null;
  isMod: boolean;
  /** The owner's account (site.users.is_admin) — see ChatSidebar. */
  isAdmin?: boolean;
  /** The newest page of chat history from the server render — see ChatSidebar. */
  initialMessages?: ChatMsg[];
  /** The emotes those rows use — see ChatSidebar. */
  initialEmotes?: EmoteMap;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useKeyboardLift(rootRef);
  return (
    // The popout has no video column — the lifted page's top exits
    // the viewport (clipped by html's overflow-hidden), which is the model's
    // other occluder.
    <div
      ref={rootRef}
      className="h-full flex flex-col overflow-hidden"
      // A page, not a pop-up: the site's page background, like every
      // other page.
      style={{ background: "var(--bg-page)" }}
    >
      <ErrorBoundary>
        <ChatSidebar isSignedIn={isSignedIn} userId={userId} canonicalId={canonicalId} isMod={isMod} isAdmin={isAdmin} isPopout initialMessages={initialMessages} initialEmotes={initialEmotes} />
      </ErrorBoundary>
    </div>
  );
}
