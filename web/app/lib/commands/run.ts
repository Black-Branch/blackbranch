import { postJson, getJson, HttpError } from "../http";
import { signature, scopeAllows, routeAvailable, type HandlerKey, type PluginHandlerKey } from "./spec";
import { platformLabel } from "../platforms";
import { parseCommandLine, argValues, missingArg, durationToMinutes, helpText, type Viewer } from "./parse";
import { parseYoutubeVideoId } from "../youtubeId";
import { resolveModTarget as resolveMatrixId } from "../modTarget";
import { resolveChatter } from "../hideTarget";
import { liveDirectory, liveViewer } from "../liveDirectory";
import { hidePerson, unhidePerson, currentLists } from "../behaviorStore";
import { pluginCommandRunner } from "../plugins/commandRunners";
import { NATIVE_PLATFORM } from "../nativePlatform.ts";
import { requestDm } from "../dm/bus.ts";
import { ANNOUNCE_MAX, resolveDmName, sendAnnouncement } from "../dm/api.ts";
import { purgeRequest, windowLabel, PURGE_MAX_MINUTES } from "../modRequests.ts";
import { DM_BANNED } from "../dm/banGate.ts";

// Executing a parsed `/` command.
//
// Replaces the hand-maintained dispatch table in useModCommands.ts. Handlers are
// keyed by the spec's HandlerKey union, so a command cannot exist without a
// handler (TypeScript) and a handler cannot be unreachable (commands.test.ts).
// A plugin's commands (`<plugin>:<name>` run keys) run through the plugin's runners instead.

/** A leaf run by the install's plugin rather than by HANDLERS below. */
function isPluginKey(key: HandlerKey | PluginHandlerKey): key is PluginHandlerKey {
  return key.includes(":");
}

export type RunOutcome =
  /** Ran (or failed with a message already surfaced). Do NOT send as chat. */
  | { kind: "handled" }
  /** Not a command at all — send it as an ordinary message. */
  | { kind: "passthrough" }
  /**
   * A ROUTING command (`/t hello`): send `text` as chat, but to `destination`
   * rather than wherever the sticky toggle points. Distinct from `passthrough`
   * because the text is the command's ARGUMENT, not the line the user typed —
   * sending the raw line would post "/t hello".
   */
  | { kind: "send"; text: string; destination: string | null; encrypted: boolean;
      spend?: "highlight" | "tts" }
  /** A command attempt that could not run. `message` explains why. */
  | { kind: "rejected"; message: string };

export type RunDeps = {
  setSendError: (msg: string | null) => void;
  showNotice: (text: string) => void;
  /**
   * Help-desk support-panel controls. Every shipped composer hosts a
   * panel — popouts included — so the refusal below is a defensive
   * branch, not a live path. It stays because the dep is optional by type: a
   * future embed/overlay composer that omits it must get a clear message rather
   * than a crash.
   */
  support?: { open: (firstMessage?: string) => void; close: () => void };
};

export function createCommandRunner({ setSendError, showNotice, support }: RunDeps) {
  async function modFetch(
    url: string, body: unknown, failMsg: string, method: "POST" | "DELETE" = "POST",
  ): Promise<boolean> {
    try {
      const res = await postJson(url, body, method);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        setSendError(t && t.length < 160 ? t : failMsg);
      }
      return res.ok;
    } catch {
      setSendError(failMsg);
      return false;
    }
  }

  async function runEmotes(action: "refresh" | "check", force: boolean): Promise<void> {
    try {
      const res = await postJson("/api/mod/emotes", { action, force });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setSendError(d.error ?? "Emote refresh failed"); return; }
      if (action === "check") {
        showNotice(
          `Dry run: would load ${d.wouldLoad} (now ${d.current}) — +${d.added} / -${d.removed}` +
          (d.guarded?.length ? ` · ⚠ would keep last-good for ${d.guarded.join(", ")}` : "")
        );
        return;
      }
      showNotice(
        `✓ Emote manifest refreshed (${d.count} loaded, was ${d.before})${force ? " [forced]" : ""}` +
        (d.guarded?.length ? ` · ⚠ kept last-good for ${d.guarded.join(", ")} (looked truncated)` : "")
      );
    } catch { setSendError("Emote refresh failed"); }
  }

  /** Handlers receive the positional argument values, already rest-joined. */
  const HANDLERS: Record<HandlerKey, (a: string[]) => Promise<void>> = {
    // ─── moderation ──────────────────────────────────────────────────────────
    ban: async ([user, reason]) => {
      if (await modFetch("/api/mod/ban",
        { targetId: resolveMatrixId(user!), reason: reason?.trim() || undefined }, "Ban failed")) {
        showNotice(`✓ Banned ${user}`);
      }
    },
    unban: async ([user]) => {
      if (await modFetch("/api/mod/ban", { targetId: resolveMatrixId(user!) }, "Unban failed", "DELETE")) {
        showNotice(`✓ Unbanned ${user}`);
      }
    },
    timeout: async ([user, dur, reason]) => {
      const mins = durationToMinutes(dur ?? "") ?? 10;
      if (await modFetch("/api/mod/ban",
        { targetId: resolveMatrixId(user!), durationMinutes: mins, reason: reason?.trim() || undefined },
        "Timeout failed")) {
        showNotice(`✓ Timed out ${user} (${mins}m)`);
      }
    },
    purge: async ([user, since]) => {
      const mins = Math.min(durationToMinutes(since ?? "") ?? PURGE_MAX_MINUTES, PURGE_MAX_MINUTES);
      if (await modFetch("/api/mod/purge",
        purgeRequest({ targetId: resolveMatrixId(user!) }, mins), "Purge failed")) {
        showNotice(`✓ Purged ${user}'s messages from the last ${windowLabel(mins)}`);
      }
    },
    slowmode: async ([first, second, forDur]) => {
      const a = (first ?? "").trim();
      const asSeconds = (v: string) => (v.toLowerCase() === "off" ? 0 : Number(v));

      // One argument that reads as a number/off → the whole room.
      const globalVal = asSeconds(a);
      if (!second?.trim() && Number.isFinite(globalVal)) {
        if (globalVal < 0) { setSendError("Usage: /slowmode <seconds | off>"); return; }
        if (await modFetch("/api/mod/slowmode", { seconds: globalVal }, "Couldn't set slow mode")) {
          showNotice(globalVal > 0 ? `✓ Slow mode: ${globalVal}s (everyone)` : "✓ Slow mode off");
        }
        return;
      }

      // Otherwise the first argument is a person.
      const seconds = asSeconds((second ?? "").trim());
      if (!Number.isFinite(seconds) || seconds < 0) {
        setSendError("Usage: /slowmode <user> <seconds | off> [for]");
        return;
      }
      const mins = forDur?.trim() ? durationToMinutes(forDur) : null;
      const ok = await modFetch("/api/mod/slowmode",
        { targetId: resolveMatrixId(a), seconds, ...(mins ? { expiresInMinutes: mins } : {}) },
        "Couldn't set slow mode");
      if (!ok) return;
      showNotice(seconds === 0
        ? `✓ ${a} is no longer rate-limited`
        : `✓ ${a}: ${seconds}s between messages${mins ? ` for ${mins}m` : " (until cleared)"}`);
    },
    slowmodeList: async () => {
      type L = { matrixId: string; seconds: number; expiresAt: string | null };
      try {
        const d = await getJson<{ userLimits?: L[]; slowModeSeconds?: number }>("/api/mod/slowmode");
        const lines: string[] = [];
        if (d.slowModeSeconds) lines.push(`everyone: ${d.slowModeSeconds}s`);
        for (const l of d.userLimits ?? []) {
          const until = l.expiresAt ? `until ${new Date(l.expiresAt).toLocaleString()}` : "until cleared";
          lines.push(`${l.matrixId.replace(/^@/, "").split(":")[0]}: ${l.seconds}s, ${until}`);
        }
        showNotice(lines.length ? lines.join("\n") : "Nobody is rate-limited");
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read slow mode"); }
    },
    setmod: async ([user]) => {
      if (await modFetch("/api/mod/setmod", { targetId: resolveMatrixId(user!), grant: true }, "Couldn't grant mod")) {
        showNotice(`✓ ${user} is now a mod`);
      }
    },
    unsetmod: async ([user]) => {
      if (await modFetch("/api/mod/setmod", { targetId: resolveMatrixId(user!), grant: false }, "Couldn't remove mod")) {
        showNotice(`✓ ${user} is no longer a mod`);
      }
    },

    // ─── timer + support bar ─────────────────────────────────────────────────
    timerControl: async () => { /* replaced below — needs the sub-command name */ },
    timerSet: async ([time]) => {
      if (await modFetch("/api/mod/timer", { action: "set", input: time }, "Couldn't set the timer")) {
        showNotice(`✓ Timer set to ${time}`);
      }
    },
    timerAdjust: async () => { /* replaced below — add vs sub */ },
    timerCap: async ([cap]) => {
      if (await modFetch("/api/mod/timer", { action: "cap", input: cap }, "Couldn't set the cap")) {
        showNotice(`✓ Timer cap: ${cap}`);
      }
    },
    // Both hit stream-api's /timer/config (usdPerHour / fillUsd) — one endpoint,
    // but they are the BAR's economics, which is why the commands live under /bar.
    barHr: async ([dollars]) => {
      if (await modFetch("/api/mod/timer", { action: "hr", value: Number(dollars) }, "Couldn't set the rate")) {
        showNotice(`✓ $${dollars} buys an hour on the timer`);
      }
    },
    barFill: async ([dollars]) => {
      if (await modFetch("/api/mod/timer", { action: "fill", value: Number(dollars) }, "Couldn't set the fill")) {
        showNotice(`✓ Bar fills at $${dollars}`);
      }
    },
    barReset: async () => {
      // Zeroes the bar AND the timer and clears overlays — see api/mod/bar.
      if (await modFetch("/api/mod/bar", { action: "reset" }, "Couldn't reset")) {
        showNotice("✓ Support bar + timer reset");
      }
    },

    // ─── read-only mod views ─────────────────────────────────────────────────
    bansList: async () => {
      type Ban = { targetName: string | null; matrixId: string; reason: string | null; expiresAt: string | null };
      try {
        const d = await getJson<{ bans?: Ban[] }>("/api/mod/bans");
        if (!d.bans?.length) { showNotice("Nobody is banned"); return; }
        showNotice(d.bans.slice(0, 15).map((b) => {
          const who = b.targetName || b.matrixId;
          const when = b.expiresAt ? `until ${new Date(b.expiresAt).toLocaleString()}` : "permanent";
          return `${who} — ${when}${b.reason ? ` (${b.reason})` : ""}`;
        }).join("\n") + (d.bans.length > 15 ? `\n…and ${d.bans.length - 15} more` : ""));
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read bans"); }
    },
    modLog: async () => {
      type Entry = { action: string; targetName: string | null; targetId: string | null; modName: string | null; durationMinutes: number | null };
      try {
        const d = await getJson<{ entries?: Entry[] }>("/api/mod/log?limit=15");
        if (!d.entries?.length) { showNotice("Mod log is empty"); return; }
        showNotice(d.entries.map((e) =>
          `${e.modName ?? "?"} ${e.action} ${e.targetName ?? e.targetId ?? ""}` +
          (e.durationMinutes ? ` (${e.durationMinutes}m)` : "")
        ).join("\n"));
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read the mod log"); }
    },
    automodList: async () => {
      type Held = { userName: string | null; userLogin: string | null; text: string };
      try {
        const d = await getJson<{ held?: Held[] }>("/api/mod/automod");
        if (!d.held?.length) { showNotice("Nothing held by automod"); return; }
        showNotice(d.held.slice(0, 10).map((h) =>
          `${h.userName ?? h.userLogin ?? "?"}: ${h.text.slice(0, 80)}`
        ).join("\n") + "\n(resolve them in the mod panel)");
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read the automod queue"); }
    },
    // ─── blocklist re-grading (migrate-v87) ──────────────────────────────────
    //
    // The outcome word ("held" / "allowed") is echoed back rather than the
    // number, because the number is an implementation detail and the OUTCOME is
    // what the mod is deciding. Severity 4 is refused by the API with its own
    // explanation, which modFetch surfaces verbatim.
    blocklistWord: async ([term, severity]) => {
      const sev = severity?.trim() ? Number(severity) : 3;
      // Validate here so a typo gets the usage line, not the route's echo of
      // `null` (NaN doesn't survive JSON.stringify).
      if (!Number.isInteger(sev) || sev < 1 || sev > 3) {
        setSendError("Usage: /blacklist word <term> [severity 1-3]"); return;
      }
      try {
        const res = await postJson("/api/mod/blocklist", { term, severity: sev });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't set that term"); return; }
        // The latency note rides every notice that INCREASES enforcement:
        // this runtime applies the rule immediately, but platform chat waits on
        // stream-api's 60s background refresh — and a mod who tests their new
        // rule from Twitch inside that minute watches it "not work" and starts
        // debugging their own fix. (whitelistWord carries the same note for the
        // same reason in the other direction.)
        showNotice(
          d.action === "allow"
            ? `✓ "${d.term}" now passes through`
            : `✓ "${d.term}" is now HELD for review (severity ${d.severity}) — takes up to a minute on platform chat`
        );
      } catch { setSendError("Couldn't set that term"); }
    },
    whitelistWord: async ([term]) => {
      try {
        const res = await postJson("/api/mod/blocklist", { term, severity: 1 });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't allow that term"); return; }
        showNotice(`✓ "${d.term}" now passes through — takes up to a minute on platform chat`);
      } catch { setSendError("Couldn't allow that term"); }
    },
    whitelistClear: async ([term]) => {
      try {
        const res = await postJson("/api/mod/blocklist", { term }, "DELETE");
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't clear that term"); return; }
        // Say what it went BACK to. Clearing an override on a severity-4 term
        // means messages start being DESTROYED again, and "✓ cleared" alone
        // reads like nothing much happened. Host rules answer differently: a
        // cleared host reverts to UNLISTED, which is held-when-armed, not
        // allowed — the route works that out via judgeHost.
        showNotice(
          d.kind === "host"
            ? d.restoredAction === "hold"
              ? `✓ host rule for ${d.term} cleared — links there are ${d.reason === "unlisted" ? "unlisted, so held while the gate is armed" : `still held (${d.reason})`}`
              : `✓ host rule for ${d.term} cleared — links there pass (baseline)`
            : d.restoredAction === "block"
              ? `✓ "${d.term}" re-graded back to BLOCKED — messages containing it are destroyed again (platform chat: up to a minute)`
              : d.restoredAction === "hold"
                ? `✓ "${d.term}" back to the shipped grading: held for review (platform chat: up to a minute)`
                : `✓ "${d.term}" cleared — it is not on the shipped list, so it now passes`
        );
      } catch { setSendError("Couldn't clear that term"); }
    },
    blocklistHost: async ([domain]) => {
      try {
        const res = await postJson("/api/mod/blocklist", { kind: "host", term: domain, severity: 3 });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't add that host"); return; }
        showNotice(`✓ links to ${d.term} are now HELD for review — takes up to a minute on platform chat`);
      } catch { setSendError("Couldn't add that host"); }
    },
    whitelistHost: async ([domain]) => {
      try {
        const res = await postJson("/api/mod/blocklist", { kind: "host", term: domain, severity: 1 });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't allow that host"); return; }
        // Shorteners and user-content hosts are refused wholesale trust no
        // matter what this says, so the notice must not promise otherwise.
        showNotice(`✓ links to ${d.term} (and its subdomains) are allowed`);
      } catch { setSendError("Couldn't allow that host"); }
    },
    linkGateSet: async ([posture]) => {
      try {
        const res = await postJson("/api/mod/linkgate", { posture });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't change the link gate"); return; }
        showNotice(
          d.posture === "hold"
            ? "✓ Link gate ARMED — links from unlisted hosts are now held for review"
            : d.posture === "flag"
              ? "✓ Link gate in FLAG mode — nothing is held, but hits are recorded so you can size it"
              : "✓ Link gate OFF — links are not checked at all"
        );
      } catch { setSendError("Couldn't change the link gate"); }
    },
    linkGateStatus: async ([line]) => {
      try {
        // `/linkgate test <line>` shares this handler: a sample means "judge
        // this, change nothing", which is the honest way to answer "what would
        // arming it do to my chat".
        if (line?.trim()) {
          const res = await postJson("/api/mod/linkgate", { sample: line });
          const d = await res.json().catch(() => ({}));
          if (!res.ok) { setSendError(d.error ?? "Couldn't test that line"); return; }
          showNotice(d.wouldHold
            ? `Would be HELD — ${d.host} (${d.reason})`
            : "Would pass");
          return;
        }
        const d = await getJson<{ posture: string; allowlisted: number; held: number }>("/api/mod/linkgate");
        showNotice(
          `Link gate: ${d.posture.toUpperCase()} · ${d.allowlisted} host(s) allowed, ${d.held} held` +
          (d.posture === "off" ? " (not checking anything)" : "")
        );
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read the link gate"); }
    },
    blocklistList: async () => {
      type Ov = {
        term: string; severity: number; action: string;
        shippedAction: string | null; isNewTerm: boolean; setBy: string;
      };
      try {
        const d = await getJson<{ overrides?: Ov[] }>("/api/mod/blocklist");
        if (!d.overrides?.length) { showNotice("No blocklist re-grades — the shipped list is in force"); return; }
        showNotice(d.overrides.map((o) =>
          `${o.term}: ${o.action}` +
          (o.isNewTerm ? " (added)" : ` (was ${o.shippedAction})`) +
          ` — ${o.setBy.replace(/^@/, "").split(":")[0]}`
        ).join("\n"));
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read the re-grades"); }
    },

    streamEnd: async () => {
      try {
        const res = await postJson("/api/mod/stream/end", {});
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(d.error ?? "Couldn't end the session"); return; }
        showNotice(d.ended ? "✓ Stream marked offline" : "Nothing was live");
      } catch { setSendError("Couldn't end the session"); }
    },

    // ─── community fallback playlist ─────────────────────────────────────────
    loopAdd: async ([url]) => {
      try {
        const res = await postJson("/api/mod/loop-videos", { url });
        const d = await res.json().catch(() => ({}));
        if (res.ok) showNotice(`✓ Added ${d.title ?? d.video_id} to the fallback playlist (#${d.priority})`);
        else setSendError(d.error ?? "Couldn't add that video");
      } catch { setSendError("Couldn't add that video"); }
    },
    loopList: async () => {
      type V = { id: number; video_id: string; title: string | null; priority: number };
      try {
        const d = await getJson<{ videos?: V[] }>("/api/mod/loop-videos");
        showNotice(d.videos?.length
          ? d.videos.map((v) => `#${v.priority} ${v.title ?? v.video_id}`).join("\n")
          : "Fallback playlist is empty — the Community source stays hidden while nobody is live");
      } catch (e) { setSendError(e instanceof HttpError ? e.message : "Couldn't read the playlist"); }
    },
    loopRemove: async ([target]) => {
      // Accept "#3" (the displayed priority), a video id, or a full URL — the API
      // deletes by row id, so resolve against the list first.
      type V = { id: number; video_id: string; priority: number };
      try {
        const d = await getJson<{ videos?: V[] }>("/api/mod/loop-videos");
        const t = (target ?? "").trim();
        const byIndex = t.startsWith("#") ? Number(t.slice(1)) : NaN;
        const vid = parseYoutubeVideoId(t);
        const hit = d.videos?.find((v) =>
          (Number.isFinite(byIndex) && v.priority === byIndex) || (vid && v.video_id === vid));
        if (!hit) { setSendError(`No playlist entry matching "${t}"`); return; }
        if (await modFetch("/api/mod/loop-videos", { id: hit.id }, "Couldn't remove", "DELETE")) {
          showNotice(`✓ Removed ${hit.video_id} from the fallback playlist`);
        }
      } catch { setSendError("Couldn't remove that video"); }
    },

    // ─── emotes ──────────────────────────────────────────────────────────────
    emotesRefresh: async () => { await runEmotes("refresh", false); },
    emotesForce: async () => { await runEmotes("refresh", true); },
    emotesCheck: async () => { await runEmotes("check", false); },

    // ─── identity ────────────────────────────────────────────────────────────
    // stream-api's one parser reads the value (she, she/her, any, clear …) — the
    // runner keeps no list of its own. `/pronouns @name she/her` is the mod form;
    // /api/mod/pronouns checks the role.
    // ⑤ Behavior: the viewer's own hide list (behaviorStore). A name resolves
    // against who has spoken in chat (the @-autocomplete's directory).
    ignore: async ([name]) => {
      const who = resolveChatter(liveDirectory(), name ?? "");
      if (!who) { showNotice("No one by that name has spoken in chat yet."); return; }
      const r = await hidePerson(who, liveViewer());
      showNotice(r === "self" ? "You can't hide yourself."
        : r === "already" ? `${who.name} is already hidden.`
        : r === "full" ? "That's the most people you can hide."
        : r === "failed" ? "Couldn't save that — try again."
        : `✓ ${who.name} is hidden — only for you. /unignore ${who.name} to undo.`);
    },
    unignore: async ([name]) => {
      const key = (name ?? "").trim().replace(/^@/, "").toLowerCase();
      const lists = await currentLists();
      const byName = lists.hidden.find((h) => h.name.toLowerCase() === key);
      const inChat = resolveChatter(liveDirectory(), key);
      const person = byName ?? (inChat ? lists.hidden.find((h) => h.id === inChat.id) : undefined);
      if (!person) { showNotice(`${name?.trim() || "That person"} isn't hidden.`); return; }
      showNotice((await unhidePerson(person.id)) ? `✓ ${person.name} is shown again.` : "Couldn't save that — try again.");
    },
    pronouns: async ([first, second]) => {
      const a = (first ?? "").trim();
      const b = (second ?? "").trim();
      const answer = async (res: Response | null, done: (p: string | null) => string, fallback: string) => {
        const d = (await res?.json().catch(() => null)) as { pronouns?: string | null; error?: string } | null;
        if (res?.ok) showNotice(done(d?.pronouns ?? null));
        else setSendError(d?.error ?? fallback);
      };
      if (a.startsWith("@") && b) {
        const res = await postJson("/api/mod/pronouns", { name: a.slice(1), value: b }).catch(() => null);
        await answer(res, (p) => (p ? `✓ ${a}'s pronouns set to ${p}` : `✓ ${a}'s pronouns cleared`), "Couldn't set their pronouns");
        return;
      }
      const res = await postJson("/api/me/pronouns", { command: a }).catch(() => null);
      await answer(res, (p) => (p ? `✓ Pronouns set to ${p}` : "✓ Pronouns cleared"), "Couldn't set pronouns");
    },

    // ─── The help desk (support) ──────────────────────────────────────────────
    // First-token dispatch instead of on/off subcommands: `/support how do I x`
    // must read "how do I x" as the message (a sub tree would eat "how" as an
    // unknown sub). Bare + "on" open, "off" closes, anything else opens with
    // that text as the first support turn.
    support: async ([rest]) => {
      if (!support) { setSendError("Support isn't available in this window — use the main site."); return; }
      const raw = (rest ?? "").trim();
      if (raw.toLowerCase() === "off") { support.close(); return; }
      if (raw === "" || raw.toLowerCase() === "on") { support.open(); return; }
      support.open(raw);
    },

    // /bug — the fast lane past the front desk: one line straight into
    // site.support_tickets (kind 'bug'), no panel involved, so it works in
    // popouts too. The route re-checks everything that matters (auth, clamp,
    // blocklist, the shared 5/min support-write limiter).
    bugReport: async ([rest]) => {
      const body = (rest ?? "").trim();
      if (!body) { setSendError("Describe it: /bug <what happened>"); return; }
      try {
        const res = await postJson("/api/support/ticket", { kind: "bug", body });
        if (res.status === 429) { setSendError("Easy — a few reports a minute is plenty."); return; }
        if (!res.ok) {
          const d = await res.json().catch(() => ({} as { error?: string }));
          setSendError(d.error === "blocked"
            ? "That report tripped the word filter — reword it."
            : "Couldn't file the bug — try again.");
          return;
        }
        showNotice("✓ Bug filed — thank you. The mods will see it.");
      } catch { setSendError("Couldn't file the bug — try again."); }
    },

    // ─── community rotation ──────────────────────────────────────────────────
    embedAdd: async ([rest]) => {
      // `/embed add y <yt> t <tw>` — flags optional, any order; a bare
      // first token is a YouTube handle (the pre-tree behaviour).
      const toks = (rest ?? "").split(/\s+/).filter(Boolean);
      const args: { youtube?: string; twitch?: string } = {};
      let usedFlags = false;
      for (let i = 0; i < toks.length; i++) {
        const t = (toks[i] ?? "").toLowerCase();
        if ((t === "y" || t === "yt" || t === "youtube") && toks[i + 1]) { args.youtube = toks[++i]; usedFlags = true; }
        else if ((t === "t" || t === "twitch") && toks[i + 1]) { args.twitch = toks[++i]; usedFlags = true; }
        else if (!usedFlags && i === 0) { args.youtube = toks[i]; }
      }
      if (!args.youtube && !args.twitch) {
        setSendError("Usage: /embed add y <youtube> t <twitch>");
        return;
      }
      try {
        const res = await postJson("/api/mod/embed", args, "POST", { timeoutMs: 8_000 });
        const d = await res.json().catch(() => ({}));
        if (res.ok) showNotice(`${d.display_name} ${d.updated ? "updated in" : "added to"} the rotation (#${d.priority})`);
        else setSendError(d.error ?? "Couldn't add embed");
      } catch { setSendError("Embed command failed"); }
    },
    embedList: async () => {
      type Row = { priority: number; display_name: string; youtube_channel_id: string | null; twitch_login: string | null };
      try {
        const d = await getJson<{ embeds?: Row[] }>("/api/mod/embed");
        showNotice(d.embeds?.length
          ? d.embeds.map((e) => {
              const p = [e.youtube_channel_id && "YT", e.twitch_login && "Twitch"].filter(Boolean).join("+");
              return `#${e.priority} ${e.display_name}${p ? ` (${p})` : ""}`;
            }).join("\n")
          : "Community rotation is empty");
      } catch (e) {
        setSendError(e instanceof HttpError ? e.message : "Couldn't list embeds");
      }
    },
    embedRemove: async ([target]) => {
      try {
        const res = await postJson("/api/mod/embed", { target }, "DELETE");
        const d = await res.json().catch(() => ({}));
        if (res.ok) showNotice(`${d.removed} removed from the rotation`);
        else setSendError(d.error ?? "Couldn't remove embed");
      } catch { setSendError("Embed command failed"); }
    },

    // ─── everyone ────────────────────────────────────────────────────────────
    dm: async ([name, text]) => {
      const q = (name ?? "").trim();
      const r = await resolveDmName(q);
      if (!r.ok) {
        setSendError(r.reason === "signin" ? "Sign in to send direct messages."
          : r.reason === "banned" ? DM_BANNED : "Couldn't look that name up — try again.");
        return;
      }
      if (!r.people.length) { setSendError(`No one else here goes by ${q}.`); return; }
      const body = text?.trim() || undefined;
      const opened = r.people.length === 1
        ? requestDm({ kind: "open", to: r.people[0]!, text: body })
        : requestDm({ kind: "pick", query: q, people: r.people, text: body });
      if (!opened) setSendError("Direct messages open in the chat panel — send it from there.");
    },
    announce: async ([text]) => {
      const t = (text ?? "").trim();
      if (t.length > ANNOUNCE_MAX) { setSendError(`An announcement is at most ${ANNOUNCE_MAX} characters.`); return; }
      const err = await sendAnnouncement(t);
      if (err) setSendError(err);
      else showNotice("✓ Announced to everyone here.");
    },
    help: async () => { /* replaced below — needs the viewer's scope */ },
  };

  /**
   * Run `text`.
   *
   * The return value MATTERS and the caller must branch on it: an unknown
   * `/foo` must be neither run nor silently dropped, for every user, not just
   * mods. `passthrough` vs `rejected` is what makes that possible.
   */
  async function runCommand(text: string, viewer: Viewer): Promise<RunOutcome> {
    const p = parseCommandLine(text);
    if (!p.isCommand) return { kind: "passthrough" };

    const leaf = p.node;
    if (!leaf || leaf.sub?.length) {
      const name = text.trim().split(/\s+/)[0];
      if (!leaf) return { kind: "rejected", message: `Unknown command ${name}. Type / to see the list.` };
      return {
        kind: "rejected",
        message: `${name} needs a sub-command: ${leaf.sub!.map((s) => s.name).join(", ")}`,
      };
    }

    if (!scopeAllows(viewer, leaf.scope)) {
      return {
        kind: "rejected",
        message: leaf.scope === "admin" ? "That command is admin-only." : "That command is for mods.",
      };
    }

    const missing = missingArg(text, p);
    if (missing) {
      return { kind: "rejected", message: `Missing <${missing}> — ${signature(p.pathNames, leaf)}` };
    }

    const args = argValues(text, p);

    // ── routing commands ─────────────────────────────────────────────────────
    // Checked BEFORE `leaf.run!` below, which these leaves deliberately do not
    // have. The client-side entitlement check is UX only (a clear refusal
    // instead of a bare 403); /api/chat/send re-checks both.
    if (leaf.route) {
      if (!routeAvailable(leaf, viewer)) {
        return {
          kind: "rejected",
          message: leaf.route.encrypted
            ? "Redacted messages are for Supporters."
            : `Link your ${platformLabel(leaf.route.destination ?? NATIVE_PLATFORM)} account first — Settings → Linked accounts`,
        };
      }
      return {
        kind: "send",
        text: args[0]!.trim(),
        destination: leaf.route.destination,
        encrypted: !!leaf.route.encrypted,
        ...(leaf.route.spend ? { spend: leaf.route.spend } : {}),
      };
    }

    const key = leaf.run!;

    // A plugin's command: the same checks above, then the plugin's runner.
    if (isPluginKey(key)) {
      const run = pluginCommandRunner(key);
      if (!run) return { kind: "rejected", message: `${text.trim().split(/\s+/)[0]} isn't available here.` };
      await run(args, { path: p.pathNames, showNotice, setSendError, modFetch });
      return { kind: "handled" };
    }

    // The handlers that need to know WHICH sub-command they were reached through
    // (one endpoint, several verbs) are dispatched here rather than duplicated
    // into near-identical entries above.
    const last = p.pathNames[p.pathNames.length - 1];
    if (key === "timerControl") {
      if (await modFetch("/api/mod/timer", { action: last }, "Timer command failed")) {
        showNotice(last === "start" ? "✓ Timer running" : "✓ Timer paused");
      }
      return { kind: "handled" };
    }
    if (key === "timerAdjust") {
      // A refused adjust is a 200 with `seconds: 0` and a `reason` sentence
      // (stream-api money.js /timer/adjust) — not an HTTP error, so modFetch's
      // boolean would report "✓ Subtracted" for a subtract that did nothing.
      // During a night only SOLD time can be taken back (the free seed hours
      // stay), and a silent refusal reads as "it didn't subtract".
      try {
        const res = await postJson("/api/mod/timer", { action: last, input: args[0] });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          setSendError(t && t.length < 160 ? t : "Timer command failed");
          return { kind: "handled" };
        }
        const d = (await res.json().catch(() => null)) as { seconds?: number; reason?: string } | null;
        if (d?.seconds === 0) {
          setSendError(d.reason || "No change — the timer refused that adjustment.");
        } else {
          showNotice(`✓ ${last === "add" ? "Added" : "Subtracted"} ${args[0]}`);
        }
      } catch {
        setSendError("Timer command failed");
      }
      return { kind: "handled" };
    }
    if (key === "help") {
      showNotice(helpText(args[0] ?? "", viewer));
      return { kind: "handled" };
    }
    // `/dm all …` / `/dm everyone …` is an announcement, so it takes the announcement's scope.
    if (key === "dm" && /^@?(all|everyone)$/i.test((args[0] ?? "").trim())) {
      if (!scopeAllows(viewer, "mod")) return { kind: "rejected", message: "Announcements are for mods." };
      if (!(args[1] ?? "").trim()) return { kind: "rejected", message: "Missing <message> — /announce <message>" };
      await HANDLERS.announce([args[1]!]);
      return { kind: "handled" };
    }

    await HANDLERS[key](args);
    return { kind: "handled" };
  }

  return { runCommand };
}
