"use client";

// Admin Panel › Site › Discord, step 2: import. The server reads one Discord server through the bridge;
// this page shows what it would become (app/lib/community/discordImport.ts, recomputed here as a role's
// rung changes) and the streamer edits it: each channel's name, who can see it, who can post, whether
// to bring it; each role's rung. Confirm writes the rows; the server builds them. A second import shows
// only what is new or changed, and never makes a channel twice. Every route behind this checks is_admin itself.

import { useCallback, useMemo, useState } from "react";
import { postJson } from "@/app/lib/http";
import type { BotView, ImportReadView } from "@/app/lib/community/discordImportAdmin";
import { diffImport, proposeCommunity, TIER_WORDS, TIERS, type ImportChoices, type Tier } from "@/app/lib/community/discordImport";
import { POST_WORDS, SEE_WORDS } from "@/app/lib/community/communityWords";
import type { PostRule, SeeRule } from "@/app/lib/community/desired";
import { btn, card, chip, h2, h3, input } from "./parts";

const LONG_MS = 120_000;
const select = `${input} h-6 bg-surface-2`;
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  booster: "Server Boosters", twitch: "Twitch, linked on Discord", youtube: "YouTube, linked on Discord", platform: "a platform linked on Discord",
  patreon: "the Patreon bot (by the role's name)", "ko-fi": "the Ko-fi bot (by the role's name)", named: "the role's name",
};
const FIELD_WORDS = { name: "name", see: "who can see", post: "who can post" } as const;
const ruleWords = (field: "name" | "see" | "post", v: string) => (field === "see" ? SEE_WORDS[v as SeeRule] ?? v : field === "post" ? POST_WORDS[v as PostRule] ?? v : `#${v}`);

export default function DiscordImportStep({ bot, note, onImported }: { bot: BotView | null; note: (m: string) => void; onImported: () => void }) {
  const servers = bot?.bot?.ok ? bot.bot.guilds : [];
  const [guildId, setGuildId] = useState("");
  const [read, setRead] = useState<ImportReadView | null>(null);
  const [tiers, setTiers] = useState<Record<string, Tier>>({});
  const [choices, setChoices] = useState<ImportChoices>({ rooms: {}, spaces: {} });
  const [busy, setBusy] = useState<"read" | "confirm" | null>(null);
  const pick = guildId || bot?.imported?.guildId || servers[0]?.id || "";

  const proposal = useMemo(() => (read ? proposeCommunity(read.guild, { roleTiers: tiers }) : null), [read, tiers]);
  const diff = useMemo(() => (read && proposal ? diffImport(proposal, read.here) : null), [read, proposal]);

  const readNow = useCallback(async () => {
    setBusy("read");
    try {
      const res = await postJson("/api/admin/community/discord/import/read", { guildId: pick.trim() }, "POST", { timeoutMs: LONG_MS });
      const j = (await res.json().catch(() => ({}))) as ImportReadView & { error?: string };
      if (!res.ok) { note(j.error ?? "Not read."); return; }
      setRead(j); setTiers(j.savedTiers); setChoices({ rooms: {}, spaces: {} });
    } catch {
      note("The site did not answer in time. Try again.");
    } finally { setBusy(null); }
  }, [note, pick]);

  const confirm = useCallback(async () => {
    if (!read) return;
    setBusy("confirm");
    try {
      const res = await postJson("/api/admin/community/discord/import", { guildId: read.guild.id, roleTiers: tiers, choices }, "POST", { timeoutMs: LONG_MS });
      const j = (await res.json().catch(() => ({}))) as { error?: string; words?: string };
      note(j.error ?? j.words ?? (res.ok ? "Imported." : "Not imported."));
      if (res.ok) { setRead(null); onImported(); }
    } catch {
      note("The site did not answer in time. Reload the page to see where it stands.");
    } finally { setBusy(null); }
  }, [choices, note, onImported, read, tiers]);

  const room = (id: string) => choices.rooms[id] ?? {};
  const setRoom = (id: string, patch: ImportChoices["rooms"][string]) => setChoices((c) => ({ ...c, rooms: { ...c.rooms, [id]: { ...c.rooms[id], ...patch } } }));
  const can = !!bot?.canCall && !!bot.bot?.ok;

  return (
    <section className={`${card} space-y-2`} aria-label="Import from Discord">
      <h2 className={h2}>2. Import the Discord server</h2>
      <p className="text-xs text-secondary">
        The server reads your Discord server&apos;s categories, channels and roles (it changes nothing on Discord) and shows what the community would become. Edit it, then confirm.
      </p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void readNow(); }}>
        {servers.length > 0 ? (
          <select className={select} aria-label="Discord server" value={pick} onChange={(e) => setGuildId(e.target.value)} disabled={!!busy}>
            {servers.map((g) => <option key={g.id} value={g.id}>{g.name || g.id}</option>)}
          </select>
        ) : (
          <input className={input} inputMode="numeric" aria-label="Discord server ID" placeholder="Discord server ID" value={guildId}
            onChange={(e) => setGuildId(e.target.value)} disabled={!!busy || !can} />
        )}
        <button type="submit" className={btn} disabled={!!busy || !can || !pick.trim()}>{busy === "read" ? "Reading…" : read ? "Read again" : "Read the server"}</button>
      </form>
      {!can && <p className="text-xs text-muted">Save the bot token first, and let Discord let the bot in (step 1).</p>}
      {bot?.imported && !read && (
        <p className="text-xs text-secondary">Imported from <span className="font-medium">{bot.imported.guildName}</span> on {new Date(bot.imported.importedAt).toLocaleString()}. Read it again to bring what is new.</p>
      )}

      {read && proposal && diff && (
        <div className="space-y-3" data-import-proposal>
          <p className="text-xs text-body" role="status">
            <span className="font-medium">{proposal.guild.name}</span>: {proposal.spaces.length} categor{proposal.spaces.length === 1 ? "y" : "ies"}, {proposal.rooms.length} channel{proposal.rooms.length === 1 ? "" : "s"}, {proposal.kept.length} kept on Discord.
            {" "}Emoji: {proposal.emoji.static} of {proposal.emoji.limit} still, {proposal.emoji.animated} of {proposal.emoji.limit} animated{proposal.emoji.fits ? "" : " (more than the server's boost level allows)"}.
          </p>
          {proposal.needsChoice.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-400/40 p-2" aria-label="Needs your choice">
              <h3 className={h3}>Needs your choice ({proposal.needsChoice.length})</h3>
              <p className="text-2xs text-secondary">No sentence says exactly what Discord does here. Each is set to the nearest one that lets in nobody Discord keeps out; change it if you like.</p>
              {proposal.needsChoice.map((n) => (
                <details key={n.discordId} className="text-2xs text-body">
                  <summary className="cursor-pointer break-all">#{n.name}: {n.words.join(" ")}</summary>
                  <ul className="mt-1 list-disc pl-4 font-mono text-muted">{n.overwrites.map((o) => <li key={o} className="break-all">{o}</li>)}</ul>
                </details>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <h3 className={h3}>Channels</h3>
            <ul className="divide-y divide-edge">
              {proposal.rooms.map((r) => {
                const st = diff.rooms.find((x) => x.discordId === r.discordId)!;
                const c = room(r.discordId);
                const on = c.include ?? st.status === "new";
                const space = r.spaceDiscordId ? proposal.spaces.find((s) => s.discordId === r.spaceDiscordId) : null;
                const spaceName = space ? (choices.spaces[space.discordId]?.name ?? space.name) : "the community itself";
                return (
                  <li key={r.discordId} className="space-y-1 py-2" data-import-room={r.name} data-status={st.status}>
                    <div className="flex flex-wrap items-center gap-2">
                      {st.status === "same" ? <span className={`${chip} text-muted`}>Already here</span> : (
                        <label className="flex items-center gap-1 text-xs text-body">
                          <input type="checkbox" checked={on} onChange={(e) => setRoom(r.discordId, { include: e.target.checked })} aria-label={`Bring #${r.name}`} />
                          {st.status === "new" ? "Bring" : "Apply the change"}
                        </label>
                      )}
                      <input className={input} aria-label={`Name for #${r.name}`} value={c.name ?? r.name} disabled={st.status === "same" || !on}
                        onChange={(e) => setRoom(r.discordId, { name: e.target.value })} />
                      <span className="min-w-0 basis-full break-words text-2xs text-muted sm:basis-auto">in {spaceName}{r.kind === "announcement" ? " · announcements" : ""}</span>
                    </div>
                    {st.status !== "same" && on && (
                      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
                        <select className={select} aria-label={`Who can see #${r.name}`} value={c.see ?? r.see} onChange={(e) => setRoom(r.discordId, { see: e.target.value as SeeRule })}>
                          {(Object.keys(SEE_WORDS) as SeeRule[]).map((k) => <option key={k} value={k}>{SEE_WORDS[k]}</option>)}
                        </select>
                        <select className={select} aria-label={`Who can post in #${r.name}`} value={c.post ?? r.post} onChange={(e) => setRoom(r.discordId, { post: e.target.value as PostRule })}>
                          {(Object.keys(POST_WORDS) as PostRule[]).map((k) => <option key={k} value={k}>{POST_WORDS[k]}</option>)}
                        </select>
                      </div>
                    )}
                    {st.status === "changed" && (
                      <p className="text-2xs text-amber-300">Differs: {st.changes.map((ch) => `${FIELD_WORDS[ch.field]} is ${ruleWords(ch.field, ch.here)} here, ${ruleWords(ch.field, ch.discord)} on Discord`).join("; ")}.</p>
                    )}
                    {r.note && <p className="text-2xs text-secondary">{r.note}</p>}
                    {st.clash && <p className="text-2xs text-amber-300">A channel named #{r.name} is already in {spaceName}: bringing this one makes a second.</p>}
                  </li>
                );
              })}
            </ul>
          </div>

          {proposal.spaces.some((s) => diff.spaces.find((x) => x.discordId === s.discordId)?.status === "new") && (
            <div className="space-y-1">
              <h3 className={h3}>New categories</h3>
              {proposal.spaces.filter((s) => diff.spaces.find((x) => x.discordId === s.discordId)?.status === "new").map((s) => (
                <input key={s.discordId} className={`${input} w-full`} aria-label={`Name for the category ${s.name}`} value={choices.spaces[s.discordId]?.name ?? s.name}
                  onChange={(e) => setChoices((c) => ({ ...c, spaces: { ...c.spaces, [s.discordId]: { name: e.target.value } } }))} />
              ))}
            </div>
          )}

          {proposal.kept.length > 0 && (
            <div className="space-y-1">
              <h3 className={h3}>Kept on Discord</h3>
              <ul className="space-y-0.5 text-2xs text-secondary">{proposal.kept.map((k) => <li key={k.discordId} className="break-all">#{k.name} ({k.kind}): {k.reason}</li>)}</ul>
            </div>
          )}
          {diff.gone.length > 0 && (
            <p className="text-2xs text-secondary">No longer on Discord, kept here: {diff.gone.map((g) => `#${g.name}`).join(", ")}. Archive them on the Community page if you no longer want them.</p>
          )}

          <div className="space-y-1">
            <h3 className={h3}>Roles</h3>
            <p className="text-2xs text-secondary">
              Each Discord role on this community&apos;s ladder, for the sentences above. This is a one-time mapping: roles here are the site&apos;s from now on.
              A Supporter role on Discord does not make anyone a supporter here; it says where your supporters come from.
            </p>
            <ul className="divide-y divide-edge">
              {proposal.roleMap.map((role) => (
                <li key={role.id} className="flex flex-wrap items-center gap-2 py-1" data-import-role={role.name}>
                  <span className="min-w-0 basis-28 grow truncate text-xs text-body">{role.name}</span>
                  {role.signal === "@everyone" ? <span className={`${chip} text-muted`}>Member</span> : (
                    <select className={select} aria-label={`Rung for ${role.name}`} value={role.tier} onChange={(e) => setTiers((t) => ({ ...t, [role.id]: e.target.value as Tier }))}>
                      {TIERS.map((k) => <option key={k} value={k}>{TIER_WORDS[k]}</option>)}
                    </select>
                  )}
                  {role.ask && <span className={`${chip} text-amber-300`}>Mod or Staff? It can manage channels on Discord</span>}
                  {role.source && <span className="basis-full text-2xs text-muted sm:basis-auto">from {SOURCE_WORDS[role.source] ?? role.source}</span>}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} disabled={!!busy} onClick={() => void confirm()}>{busy === "confirm" ? "Importing…" : "Confirm the import"}</button>
            <button type="button" className={btn} disabled={!!busy} onClick={() => setRead(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
