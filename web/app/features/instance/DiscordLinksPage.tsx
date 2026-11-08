"use client";

// Admin Panel › Site › Discord: the Discord bridge's state, then the steps — the bot (DiscordBotStep),
// the import (DiscordImportStep), the Discord server the community is linked to, and the Links table
// (each room ↔ its Discord channel, with what the bridge itself holds). Linking goes through the
// bridge's own API (app/lib/community/discordAdmin.ts); a press can take a minute when the server
// first has to seat the bridge's bot.
//
// Every route behind this checks is_admin itself; this component being admin-only is not the guard.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { DiscordRoomView, DiscordView } from "@/app/lib/community/discordAdmin";
import type { BotView } from "@/app/lib/community/discordImportAdmin";
import type { SetupPage } from "@/app/lib/setup/setupPages";
import { ago, btn, card, chip, h2, input } from "./parts";
import DiscordBotStep from "./DiscordBotStep";
import DiscordImportStep from "./DiscordImportStep";

const LONG_MS = 120_000;
const STATE_WORDS = { on: "on", off: "off", waiting: "waiting" } as const;
const STATE_DOT = { on: "bg-green-400", off: "bg-surface-4", waiting: "bg-amber-400" } as const;

/** The bridge's own word on a room's link. */
function linkStatus(r: DiscordRoomView): { words: string; tone: string } {
  if (r.bridged) return { words: "Linked", tone: "text-green-300" };
  if (r.channelId) return { words: "Waiting for the bridge", tone: "text-amber-300" };
  if (r.see !== "everyone" || r.post !== "everyone") return { words: "Only rooms everyone can see and post in", tone: "text-muted" };
  if (!r.made) return { words: "Not made yet", tone: "text-muted" };
  return { words: "Not linked", tone: "text-muted" };
}

export default function DiscordLinksPage({ note, guide }: { note: (m: string) => void; guide: SetupPage | null }) {
  const [view, setView] = useState<DiscordView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [guild, setGuild] = useState("");
  const [channels, setChannels] = useState<Record<number, string>>({});
  const [bot, setBot] = useState<BotView | null>(null);
  const [botKey, setBotKey] = useState(0);

  const load = useCallback(() => {
    getJson<DiscordView>("/api/admin/community/discord", { cache: "no-store" })
      .then((v) => { setView(v); setErr(null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (key: string, url: string, method: "POST" | "DELETE", body?: unknown) => {
    setBusy(key);
    try {
      const res = await postJson(url, body, method, { timeoutMs: LONG_MS });
      const j = (await res.json().catch(() => ({}))) as { error?: string; words?: string };
      note(j.error ?? j.words ?? (res.ok ? "Done." : "Not done."));
      return res.ok;
    } catch {
      note("The site did not answer in time. Reload the page to see where it stands.");
      return false;
    } finally {
      setBusy(null);
      load();
    }
  }, [load, note]);

  if (err) return <p className="text-sm text-red-300">Could not load the Discord links: {err}</p>;
  if (!view) return <p role="status" className="text-sm text-muted">Loading the Discord links…</p>;
  const ready = view.bridge.state === "on" && view.canCall;
  const rooms = view.rooms.filter((r) => !r.archived);

  return (
    <>
      <section className={`${card} space-y-1`} aria-label="Discord bridge" data-discord-bridge={view.bridge.state}>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className={`size-2 rounded-full ${STATE_DOT[view.bridge.state]}`} />
          <h2 className={h2}>Discord bridge: {STATE_WORDS[view.bridge.state]}</h2>
        </div>
        <p className="text-xs text-secondary">{view.bridge.words}</p>
        {!view.canCall && view.bridge.state !== "off" && (
          <p className="text-xs text-amber-300">This install cannot ask its server to reach the bridge, so nothing can be linked from here.</p>
        )}
      </section>

      <DiscordBotStep key={botKey} note={note} onBot={setBot} guide={guide} />
      <DiscordImportStep bot={bot} note={note} onImported={() => { setBotKey((k) => k + 1); load(); }} />

      <section className={`${card} space-y-2`} aria-label="Discord server">
        <h2 className={h2}>3. Link the Discord server</h2>
        {view.guildId ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto min-w-0 text-xs text-body">
              The community is linked to Discord server <span className="font-mono break-all">{view.guildId}</span>. Its name and picture follow the Discord server.
            </p>
            <button type="button" className={btn} disabled={!ready || !!busy}
              onClick={() => {
                if (window.confirm("Unlink the Discord server? Every room is unlinked, and the bridge's bot LEAVES the Discord server: to link anything again, add the bot to the server again.")) {
                  void act("server", "/api/admin/community/discord/server", "DELETE");
                }
              }}>{busy === "server" ? "Unlinking…" : "Unlink the server"}</button>
          </div>
        ) : (
          <>
            <p className="text-xs text-secondary">
              Add the bridge&apos;s bot to your Discord server first. Then paste the server&apos;s ID here (in Discord, with Developer Mode on: right-click the server, Copy Server ID).
            </p>
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
              e.preventDefault();
              void act("server", "/api/admin/community/discord/server", "POST", { guildId: guild.trim() }).then((ok) => { if (ok) setGuild(""); });
            }}>
              <input className={input} inputMode="numeric" aria-label="Discord server ID" placeholder="Discord server ID" value={guild}
                onChange={(e) => setGuild(e.target.value)} disabled={!ready || !!busy} />
              <button type="submit" className={btn} disabled={!ready || !!busy || !guild.trim()}>{busy === "server" ? "Linking… (up to a minute)" : "Link the server"}</button>
            </form>
          </>
        )}
      </section>

      <section className={`${card} space-y-2`} aria-label="Links">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={`${h2} mr-auto`}>4. Links</h2>
          <span className="text-2xs text-muted">Read from the bridge {ago(view.linksAt)}</span>
          <button type="button" className={btn} disabled={!ready || !!busy} onClick={() => void act("refresh", "/api/admin/community/discord/refresh", "POST")}>Check again</button>
        </div>
        {!view.linksKnown && view.canCall && view.bridge.state !== "off" && (
          <p role="status" className="text-xs text-amber-300">
            The site cannot read what the bridge has linked right now, so the table shows only what this site asked for. Press Check again.
          </p>
        )}
        <p className="text-xs text-secondary">
          A linked room shows its Discord channel&apos;s messages, and its own reach Discord. Who can post in it, and who can join it, follow Discord.
          Only a room everyone in the community can see and post in can be linked.
        </p>
        {!rooms.length && <p className="text-xs text-muted">The community has no rooms yet.</p>}
        <ul className="divide-y divide-edge">
          {rooms.map((r) => {
            const st = linkStatus(r);
            const linkable = ready && !!view.guildId && r.see === "everyone" && r.post === "everyone" && r.made;
            // A room imported from Discord offers its own channel.
            const value = channels[r.id] ?? r.importedFrom ?? "";
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2" data-link-room={r.name}>
                <span className="min-w-0 basis-28 grow truncate text-xs font-medium text-body">#{r.name}</span>
                <span className={`${chip} ${st.tone}`}>{st.words}</span>
                {r.channelId ? (
                  <>
                    <span className="min-w-0 basis-full text-2xs text-muted sm:basis-auto">Channel <span className="font-mono break-all">{r.channelId}</span></span>
                    {!r.bridged && <button type="button" className={btn} disabled={!ready || !!busy}
                      onClick={() => void act(`room${r.id}`, "/api/admin/community/discord/links", "POST", { roomId: r.id, channelId: r.channelId })}>
                      {busy === `room${r.id}` ? "Linking…" : "Try again"}</button>}
                    <button type="button" className={btn} disabled={!view.canCall || !!busy}
                      onClick={() => void act(`un${r.id}`, "/api/admin/community/discord/links", "DELETE", { roomId: r.id })}>
                      {busy === `un${r.id}` ? "Unlinking…" : "Unlink"}</button>
                  </>
                ) : linkable && (
                  <form className="flex basis-full flex-wrap items-center gap-2" onSubmit={(e) => {
                    e.preventDefault();
                    void act(`room${r.id}`, "/api/admin/community/discord/links", "POST", { roomId: r.id, channelId: value.trim() })
                      .then((ok) => { if (ok) setChannels((c) => ({ ...c, [r.id]: "" })); });
                  }}>
                    <input className={input} inputMode="numeric" aria-label={`Discord channel ID for #${r.name}`} placeholder="Discord channel ID" value={value}
                      onChange={(e) => setChannels((c) => ({ ...c, [r.id]: e.target.value }))} disabled={!!busy} />
                    <button type="submit" className={btn} disabled={!!busy || !value.trim()}>{busy === `room${r.id}` ? "Linking… (up to a minute)" : "Link"}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-2xs text-muted">
          Known limits: a Matrix thread reply reaches Discord as a plain reply; stickers reach Discord as a link; Discord files over 5 MB arrive as links.
        </p>
      </section>
    </>
  );
}
