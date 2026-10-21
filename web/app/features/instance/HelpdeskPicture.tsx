"use client";

// Admin Panel → AI → Help Desk: the picture the help desk shows beside its answers. It is the bot
// account's own avatar (the public avatar route, /api/avatar/public/bot); an install whose bot has
// none shows the site icon instead (the icon folder's icon-192.png, install key site.iconSet), so a
// fresh install never shows a broken image. Changing it is changing one of those two pictures —
// no setting of its own.

import { useState } from "react";
import { siteIcon } from "@/app/lib/siteIcons";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { card, h2 } from "./parts";
import { currentValue } from "./keyRowText";

const BOT_PICTURE = "/api/avatar/public/bot";

/** The bot account from the settings view (bot.matrixId), or null when none is set. */
export function botMatrixId(view: Pick<InstanceView, "keys">): string | null {
  const k = view.keys.find((x) => x.key === "bot.matrixId");
  const v = k ? currentValue(k) : null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export default function HelpdeskPicture({ botId }: {
  /** The bot account (setting bot.matrixId), or null while none is set. */
  botId: string | null;
}) {
  // The bot account answered with no picture (or there is no bot account): the site icon shows.
  const [fallback, setFallback] = useState(!botId);
  const src = fallback ? siteIcon("icon-192.png") : BOT_PICTURE;
  return (
    <section className={card} aria-label="Help desk picture" data-helpdesk-picture={fallback ? "site-icon" : "bot"}>
      <h2 className={h2}>Picture</h2>
      <div className="mt-2 flex items-start gap-3">
        <img src={src} alt="" className="size-10 shrink-0 rounded-full object-cover bg-surface-2" onError={() => setFallback(true)} />
        <div className="min-w-0 space-y-1 text-xs text-secondary">
          <p>
            {fallback
              ? "The help desk shows the site icon: the bot account has no picture."
              : "The help desk shows the bot account's picture."}
          </p>
          <p className="text-muted">
            To change it, give the bot account a picture: sign in to the community as{" "}
            {botId ? <span className="font-mono text-body-dim break-all">{botId}</span> : "the bot account (AI → Chat Bot)"}{" "}
            and set its avatar. With none, the site&apos;s own icon shows.
          </p>
        </div>
      </div>
    </section>
  );
}
