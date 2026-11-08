"use client";

import { useEffect, useState } from "react";
import { RoomStateEvent } from "matrix-js-sdk";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { MXC_RE } from "@/app/lib/matrixHtml";
import { SPACE_BANNER, readFirst } from "@/app/lib/matrixNamespace";

/** The space's banner: the url of its banner state event, when it is a well-formed mxc. */
function bannerOf(room: Room | null): string | null {
  if (!room) return null;
  return readFirst(SPACE_BANNER, (type) => {
    const url = (room.currentState.getStateEvents(type, "")?.getContent() as { url?: unknown } | undefined)?.url;
    return typeof url === "string" && MXC_RE.test(url) ? url : null;
  }) ?? null;
}

/** A space's banner (the wide picture over its channel list), live: a banner set or removed while
 *  the list is open shows at once. null = none, the plain header. */
export function useSpaceBanner(room: Room | null): string | null {
  const [seen, setSeen] = useState<Room | null>(room);
  const [url, setUrl] = useState<string | null>(() => bannerOf(room));
  if (seen !== room) {
    setSeen(room);
    setUrl(bannerOf(room));
  }

  useEffect(() => {
    if (!room) return;
    const onState = (ev: MatrixEvent) => {
      if ((SPACE_BANNER.read as readonly string[]).includes(ev.getType())) setUrl(bannerOf(room));
    };
    room.on(RoomStateEvent.Events, onState);
    return () => { room.off(RoomStateEvent.Events, onState); };
  }, [room]);

  return url;
}
