"use client";

import { useEffect, useState } from "react";
import { Toggle } from "./SettingsControls";
import DeleteAccount from "./DeleteAccount";

// The account card's Privacy page. One setting: whether the bot may keep
// memory of this person's messages (site.memory_opt_outs, via /api/me/memory).
// Server-stored, so it holds on every device and for every linked platform account.
export default function PrivacySettings() {
  const [remember, setRemember] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/memory", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { remember?: boolean } | null) => { if (!cancelled) setRemember(d?.remember ?? null); })
      .catch(() => { if (!cancelled) setNote("Couldn't load this setting."); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (remember === null || busy) return;
    const next = !remember;
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/me/memory", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remember: next }),
    }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { remember?: boolean; forgotten?: number } | null;
    setBusy(false);
    if (!res?.ok || typeof d?.remember !== "boolean") { setNote("Couldn't save — try again."); return; }
    setRemember(d.remember);
    setNote(d.remember ? "Saved. New messages can be remembered again." : "Saved. What the bot remembered about you has been deleted.");
  }

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-start gap-3 px-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-body">Let the bot remember my messages</p>
          <p className="mt-1 text-xs text-muted leading-relaxed">
            On: the chat bot may keep a memory of your messages to recall later and to get to know you.
            Off: it stops, and what it already remembers about you is deleted right away — for this account
            and the platform accounts linked to it. The bot still sees recent chat while it is on screen,
            the way everyone in chat does; that is not memory.
          </p>
        </div>
        <Toggle
          on={remember === true}
          onToggle={() => void toggle()}
          label="Let the bot remember my messages"
          disabled={remember === null || busy}
        />
      </div>
      {note && <p role="status" className="px-1 text-xs text-secondary">{note}</p>}
      <p className="px-1 text-xs text-muted">
        More in <a href="/legal#privacy" className="underline hover:text-secondary">Terms &amp; Privacy</a>.
      </p>
      <DeleteAccount />
    </div>
  );
}
