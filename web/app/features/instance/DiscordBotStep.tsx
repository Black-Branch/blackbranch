"use client";

// Admin Panel › Site › Discord, step 1: the bot. The streamer makes a Discord application of this
// install's own, switches on its privileged intents, pastes its bot token here (the server writes it
// into its settings file; the site keeps no copy), then adds the bot to the Discord server with the
// link built from the application. Every route behind this checks is_admin itself.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { BotView } from "@/app/lib/community/discordImportAdmin";
import type { SetupPage } from "@/app/lib/setup/setupPages";
import SetupStepGuide from "@/app/components/SetupStepGuide";
import { btn, card, chip, h2, input } from "./parts";

const LONG_MS = 120_000;

/** `guide`: the Discord setup list (config/setup-core.mjs `discord`) as the settings view computes
 *  it — the steps on Discord's side, in the same words as the public docs' Discord page. */
export default function DiscordBotStep({ note, onBot, guide }: { note: (m: string) => void; onBot: (v: BotView | null) => void; guide: SetupPage | null }) {
  const [view, setView] = useState<BotView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"token" | "check" | null>(null);

  const load = useCallback(() => {
    getJson<BotView>("/api/admin/community/discord/bot", { cache: "no-store" })
      .then((v) => { setView(v); onBot(v); setErr(null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "could not load"));
  }, [onBot]);
  useEffect(() => { load(); }, [load]);

  const send = useCallback(async (what: "token" | "check") => {
    setBusy(what);
    try {
      const res = what === "token"
        ? await postJson("/api/admin/community/discord/bot", { token: token.trim() }, "POST", { timeoutMs: LONG_MS })
        : await postJson("/api/admin/community/discord/bot/check", undefined, "POST", { timeoutMs: LONG_MS });
      const j = (await res.json().catch(() => ({}))) as { error?: string; words?: string };
      note(j.error ?? j.words ?? (res.ok ? "Done." : "Not done."));
      if (res.ok && what === "token") setToken("");
    } catch {
      note("The site did not answer in time. Reload the page to see where it stands.");
    } finally {
      setBusy(null);
      load();
    }
  }, [load, note, token]);

  if (err) return <p className="text-sm text-red-300">Could not load the Discord bot: {err}</p>;
  const bot = view?.bot ?? null;
  const missing = bot?.ok ? [!bot.intents.members && "Server Members", !bot.intents.content && "Message Content"].filter(Boolean) : [];

  return (
    <section className={`${card} space-y-2`} aria-label="Discord bot" data-discord-bot={bot ? (bot.ok ? "ok" : "refused") : "none"}>
      <h2 className={h2}>1. The bot</h2>
      {guide ? (
        <ol className="space-y-3" aria-label="On Discord's side">
          {guide.steps.map((s) => <li key={s.id} className="border-t border-edge pt-3 first:border-t-0 first:pt-0"><SetupStepGuide step={s} /></li>)}
        </ol>
      ) : <p role="status" className="text-xs text-muted">Loading the steps…</p>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void send("token"); }}>
        <input className={input} type="password" autoComplete="off" spellCheck={false} aria-label="Discord bot token" placeholder="Bot token"
          value={token} onChange={(e) => setToken(e.target.value)} disabled={!!busy || !view?.canCall} />
        <button type="submit" className={btn} disabled={!!busy || !token.trim() || !view?.canCall}>{busy === "token" ? "Saving… (up to a minute)" : "Save the token"}</button>
      </form>
      {view && !view.canCall && <p className="text-xs text-amber-300">This install cannot ask its server to keep a bot token (it is not the bundle).</p>}
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto min-w-0 text-xs text-body" role="status">
          {!bot ? "No bot read yet."
            : bot.ok ? <>Discord lets the bot in{bot.name ? <>: <span className="font-medium break-all">{bot.name}</span></> : null}. It is in {bot.guilds.length} Discord server{bot.guilds.length === 1 ? "" : "s"}.</>
            : <span className="text-red-300">Discord did not let the bot in: {bot.error}{bot.status ? ` (${bot.status})` : ""}.</span>}
        </p>
        <button type="button" className={btn} disabled={!!busy || !view?.canCall} onClick={() => void send("check")}>{busy === "check" ? "Checking…" : "Check again"}</button>
      </div>
      {missing.length > 0 && (
        <p className="text-xs text-amber-300">Switch on {missing.join(" and ")} Intent on the application&apos;s Bot page: without it the bridge cannot see {missing.includes("Message Content") ? "what people write" : "who is in the server"}.</p>
      )}
      {bot?.ok && (
        bot.invite ? (
          <p className="text-xs text-secondary">
            Add the bot to your Discord server: <a className="text-body underline hover:text-strong" href={bot.invite} target="_blank" rel="noopener noreferrer">open Discord&apos;s add-the-bot page</a>, pick the server, Authorize. Then press Check again.
          </p>
        ) : <p className="text-xs text-amber-300">The bridge did not give its add-the-bot link. Run sudo blackbranch logs ooye on the server.</p>
      )}
      {bot?.ok && bot.guilds.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="The bot's Discord servers">
          {bot.guilds.map((g) => <li key={g.id} className={`${chip} text-body`}>{g.name || g.id}</li>)}
        </ul>
      )}
    </section>
  );
}
