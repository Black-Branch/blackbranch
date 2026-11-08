"use client";

// Unread DMs in the server rail (client polish Task 20; k's item 9, Discord's rule): one picture per
// person with an unread line, newest first, at most five, with the unread count, under Home and
// above the spaces. A tap opens that conversation; the chip leaves once it is read (the read receipt
// for its newest line clears the room's count — the Community timeline sends it).

import { avatarStyle } from "@/app/lib/avatarSize";
import { Avatar } from "@/app/components/Avatar";
import { partnerFace, type DmConversation } from "@/app/lib/dmConversations";
import { UnreadDot } from "./parts";

const MAX_CHIPS = 5;

/** The conversations that get a chip: unread, newest line first, at most five. */
function railChipConversations(conversations: DmConversation[]): DmConversation[] {
  return conversations.filter((c) => c.unread.total > 0).sort((a, b) => b.lastTs - a.lastTs).slice(0, MAX_CHIPS);
}

export function DmRailChips({ conversations, onOpen }: { conversations: DmConversation[]; onOpen: (c: DmConversation) => void }) {
  const chips = railChipConversations(conversations);
  if (!chips.length) return null;
  return (
    <div data-dm-rail-chips="" className="w-full flex flex-col items-center gap-2">
      {chips.map((c) => {
        const face = partnerFace(c);
        return (
          <div key={c.partner} className="relative w-full flex justify-center">
            <button type="button" data-dm-chip={c.partner} onClick={() => onOpen(c)}
              title={`${face.label}, ${c.unread.total} unread`} aria-label={`Open your conversation with ${face.label}, ${c.unread.total} unread`}
              // The rail's tile: the scale's lg step, as the rail's own profile button.
              style={avatarStyle("lg")}
              className="avatar relative focus-visible:outline focus-visible:outline-edge-bright">
              <Avatar mxcUrl={face.mxc} name={face.label} size="lg" />
              <span className="absolute -bottom-1 -right-1 flex rounded-full border-2 border-[var(--bg-body-end,#111827)]">
                <UnreadDot total={c.unread.total} highlight={c.unread.highlight} mode="counts" />
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
