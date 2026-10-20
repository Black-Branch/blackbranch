"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/app/lib/http";

// One fetch per page load, shared by every picker mount (same shape as
// usePersonalEmotes). The value is site-global and public, so unlike the
// personal set it could be cached harder — but one 60-byte request per load
// isn't worth a cache-invalidation story.
let fetched: Promise<string | null> | null = null;
function fetchChannelName(): Promise<string | null> {
  if (!fetched) {
    fetched = getJson<{ twitchChannel?: string | null }>("/api/emotes/meta")
      .then((d) => d?.twitchChannel ?? null)
      .catch(() => null);
  }
  return fetched;
}

/** The channel name labeling the picker's channel-emote group; null until
 *  known (or when unconfigured — the picker then shows a neutral label). */
export function useEmoteChannelName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void fetchChannelName().then((v) => { if (on) setName(v); });
    return () => { on = false; };
  }, []);
  return name;
}
