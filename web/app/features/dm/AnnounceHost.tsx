"use client";

// A mod's announcement: slides up in the chat column for everyone
// and closes itself after 20 s. Not Matrix, nothing to answer, the send-to button untouched. A
// newer announcement replaces the one showing.

import { useEffect, useState } from "react";
import { Megaphone } from "@phosphor-icons/react/dist/ssr";
import { Window } from "@/app/components/chrome";
import { getActiveTarget } from "@/app/lib/chrome/windowLayer";
import { onAnnouncement, type Announcement } from "@/app/lib/dm/bus";

const SHOW_MS = 20_000;

function AnnounceWindow({ a, onClose }: { a: Announcement; onClose: () => void }) {
  const [presentation] = useState<"panel" | "floating">(() => {
    const layer = getActiveTarget();
    return layer && layer.offsetWidth > 0 && layer.offsetHeight > 0 ? "panel" : "floating";
  });
  return (
    <Window
      presentation={presentation}
      kind="peek"
      name="Announcement"
      mark={<Megaphone size={14} weight="bold" />}
      title="Announcement"
      defaultSize={{ w: 360, h: 200 }}
      fitHeight
      autoDismissMs={SHOW_MS}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1 p-3" data-announcement={a.id}>
        <p className="text-chat-md text-heading whitespace-pre-wrap break-words">{a.text}</p>
        {a.by && <p className="text-2xs text-muted">— {a.by}</p>}
      </div>
    </Window>
  );
}

export default function AnnounceHost() {
  const [shown, setShown] = useState<Announcement | null>(null);
  useEffect(() => onAnnouncement(setShown), []);
  if (!shown) return null;
  return <AnnounceWindow key={shown.id} a={shown} onClose={() => setShown((s) => (s?.id === shown.id ? null : s))} />;
}
