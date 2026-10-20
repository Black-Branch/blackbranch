"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/app/lib/http";
import type { EmoteMap } from "./emoteMap";
import { emoteReadiness } from "./emoteReadiness";

export type PersonalEmotesState = { emotes: EmoteMap; needsRelink: boolean };
const EMPTY: PersonalEmotesState = { emotes: {}, needsRelink: false };

let fetched: Promise<PersonalEmotesState> | null = null;
function fetchMine(): Promise<PersonalEmotesState> {
  if (!fetched) {
    emoteReadiness.advance("personal", "active");
    fetched = getJson<PersonalEmotesState>("/api/emotes/mine")
      .then((d) => (d && d.emotes ? d : EMPTY))
      .catch(() => EMPTY) // signed-out (401) and failures read as "no personal set"
      .then((d) => { emoteReadiness.advance("personal", "done"); return d; });
  }
  return fetched;
}

/** The signed-in user's own Twitch emotes for INPUT surfaces (picker +
 *  autocomplete). One fetch per page load, shared by every composer. */
export function usePersonalEmotes(): PersonalEmotesState {
  const [data, setData] = useState<PersonalEmotesState>(EMPTY);
  useEffect(() => {
    let on = true;
    void fetchMine().then((d) => { if (on) setData(d); });
    return () => { on = false; };
  }, []);
  return data;
}
