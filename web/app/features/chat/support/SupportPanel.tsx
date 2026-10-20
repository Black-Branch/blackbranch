"use client";

import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react/dist/ssr";
import type { ConvoState } from "./conversation";
import type { BadgeDef } from "@/app/lib/BadgesContext";
import { useBotName } from "@/app/lib/useBotName";

// The help desk — the support conversation surface. An ordinary element of the chat column,
// mounted between the messages and the composer: never a pop-up portalled to <body>. A pop-up
// pinned to the composer's coordinates floated over whatever tab was showing (Home, on a phone)
// and pointed at a composer that was not on screen. In the column it appears where the chat is,
// and only when the chat is.
// There is NO text input here: the composer in support mode is the panel's
// input — one keyboard path, ever. Its name is the install's bot.name ("Help" unset).

// The PUBLIC avatar route — the support panel is reachable signed-out, and
// /api/avatar/user fetches media with the VIEWER's token, so it served a
// letter circle to exactly the people meeting the help desk for the first time.
// By ROLE, so this client file carries no account id (the bot's id is an instance setting).
const BOT_PFP = "/api/avatar/public/bot";

type Props = {
  state: ConvoState;
  onPick: (key: string) => void;
  onClose: () => void;
  self: { name: string; color: string | null; badges: BadgeDef[] };
};

export function SupportPanel({ state, onPick, onClose, self }: Props) {
  const threadRef = useRef<HTMLDivElement>(null);
  const name = useBotName("Help");

  // Keep the newest line in view as the thread grows.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.msgs.length]);

  return (
    <section
      aria-label={`${name} support`}
      // Shrinks before the composer does: the thread scrolls inside, and the chat above keeps at
      // least half the column.
      // The glass FILL without the blur — what in-flow surfaces use (glassSurface.test.ts) — so the
      // panel stays legible on any page background, as the pop-up it replaced was.
      className="support-in mx-2 mb-2 flex min-h-0 shrink flex-col overflow-hidden rounded-xl border border-edge"
      style={{ maxHeight: "min(420px, 50%)", background: "var(--glass-bg)" }}
    >
      {/* Header: his face, his name, the way out. */}
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <img src={BOT_PFP} alt="" className="h-6 w-6 rounded-full object-cover" />
        <span className="text-sm font-semibold text-heading">{name}</span>
        <span className="text-xs text-muted">support</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close support"
          className="ml-auto rounded p-1 text-muted hover:bg-surface-3 hover:text-body"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      {/* The thread — mirrors chat's name treatment, not its full row chrome. */}
      <div ref={threadRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {state.msgs.map((m) =>
          m.role === "bot" ? (
            <div key={m.id} className="flex items-start gap-2">
              <img src={BOT_PFP} alt="" className="mt-0.5 h-5 w-5 shrink-0 rounded-full object-cover" />
              <p className="text-sm leading-snug text-body">{m.text}</p>
            </div>
          ) : (
            <div key={m.id} className="pl-7">
              <span className="mr-1 inline-flex items-center gap-0.5 align-middle">
                {self.badges.map((b) => (
                  <img key={b.id} src={b.imageUrl} alt={b.name} title={b.name} className="inline-block h-3.5 w-auto" />
                ))}
              </span>
              <span className="text-sm font-semibold" style={self.color ? { color: self.color } : undefined}>
                {self.name}
              </span>
              <span className="ml-1.5 text-sm leading-snug text-body-dim">{m.text}</span>
            </div>
          ),
        )}
        {state.awaiting === "busy" && (
          <div className="flex items-center gap-2 pl-7 text-sm text-muted" aria-live="polite">
            <span className="animate-pulse">{name} is typing…</span>
          </div>
        )}
      </div>

      {/* Quick replies — the deterministic flows. Free text goes through the
          composer below (support mode), never an input here. */}
      {state.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-edge px-3 py-2">
          {state.options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => onPick(o.key)}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-body-dim hover:bg-surface-3 hover:text-body"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {state.options.length === 0 && state.awaiting !== "busy" && (
        <div className="border-t border-edge px-3 py-1.5 text-xs text-muted">
          Type below — you&apos;re talking to {name}, not the chat.
        </div>
      )}
    </section>
  );
}
