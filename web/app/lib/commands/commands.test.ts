// Tests for the `/` command spec + parser.
//
// Run: node --test app/lib/commands/commands.test.ts
//
// The tree includes the install plugin's commands (app/lib/plugins/commands.ts, `@owner/commands`),
// which bare node cannot resolve — testTsx's loader resolves it like next.config.ts, so the spec is
// imported after it. The plugin's own commands are tested beside them in the owner folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "../testTsx.ts";
import type { CommandNode } from "./spec.ts";
import { DEST_ORDER, canCrossPost } from "../platforms.ts";

const { COMMANDS, leaves, signature, scopeAllows } = await import("./spec.ts");
const {
  parseCommandLine, suggestFor, applySuggestion, currentArg, hintLine,
  durationToMinutes, helpText, argValues, missingArg,
} = await import("./parse.ts");

const MOD = { isMod: true, isAdmin: false };
const ADMIN = { isMod: true, isAdmin: true };
const VIEWER = { isMod: false, isAdmin: false };

// ─── spec integrity ───────────────────────────────────────────────────────────

test("every leaf has exactly one of a handler or a route, and every branch has children", () => {
  const walk = (nodes: CommandNode[], path: string[]) => {
    for (const n of nodes) {
      const here = [...path, n.name].join(" ");
      if (n.sub?.length) {
        assert.ok(!n.run, `${here}: a branch must not also have a handler`);
        assert.ok(!n.route, `${here}: a branch must not also have a route`);
        walk(n.sub, [...path, n.name]);
      } else {
        // Exactly one. Both would be ambiguous (run.ts checks `route` first, so
        // the handler would be silently dead); neither leaves the leaf inert.
        assert.equal(
          Number(!!n.run) + Number(!!n.route), 1,
          `${here}: a leaf needs exactly one of run/route`,
        );
      }
    }
  };
  walk(COMMANDS, []);
});

test("no duplicate names or aliases at any level", () => {
  const walk = (nodes: CommandNode[], path: string) => {
    const seen = new Set<string>();
    for (const n of nodes) {
      for (const name of [n.name, ...(n.aliases ?? [])]) {
        assert.ok(!seen.has(name), `${path}: "${name}" declared twice — the parser takes the first`);
        seen.add(name);
      }
      if (n.sub) walk(n.sub, `${path}/${n.name}`);
    }
  };
  walk(COMMANDS, "");
});

test("a required argument never follows an optional one", () => {
  // Positional parsing cannot express it, so it would silently mis-bind.
  for (const { path, node } of leaves()) {
    let sawOptional = false;
    for (const a of node.args ?? []) {
      if (a.required) {
        assert.ok(!sawOptional, `/${path.join(" ")}: required "${a.name}" follows an optional arg`);
      } else sawOptional = true;
    }
  }
});

test("at most one rest argument, and it is last", () => {
  for (const { path, node } of leaves()) {
    const args = node.args ?? [];
    const rest = args.map((a, i) => (a.kind === "text" && a.rest ? i : -1)).filter((i) => i >= 0);
    assert.ok(rest.length <= 1, `/${path.join(" ")}: more than one rest argument`);
    if (rest.length === 1) {
      assert.equal(rest[0], args.length - 1, `/${path.join(" ")}: rest argument is not last`);
    }
  }
});

// ─── scope ────────────────────────────────────────────────────────────────────

test("scope gates what is offered", () => {
  assert.equal(scopeAllows(VIEWER, "all"), true);
  assert.equal(scopeAllows(VIEWER, "mod"), false);
  assert.equal(scopeAllows(MOD, "mod"), true);
  assert.equal(scopeAllows(MOD, "admin"), false, "a mod is not an admin");
  assert.equal(scopeAllows(ADMIN, "admin"), true);
});

test("a plain viewer is offered only the everyone-scoped commands", () => {
  // VIEWER declares no `dests`, which routeAvailable reads as "the caller did
  // not say" → every routing command is offered. The linked-account filtering
  // is asserted separately below.
  const s = suggestFor(parseCommandLine("/"), VIEWER).map((x) => x.value);
  assert.deepEqual(s.sort(), [
    "/bug", "/dm", "/help", "/highlight", "/ignore", "/kick", "/pronouns",
    "/redact", "/site", "/streamplace", "/support", "/tts", "/twitch", "/unignore", "/youtube",
  ]);
});

// ─── destination routing ──────────────────────────────────────────────────────

test("every cross-postable platform has a routing command, and vice versa", () => {
  // The drift guard. A platform added to DEST_ORDER but not here would be
  // reachable by the toggle and not by a command; a command for a platform we
  // cannot cross-post to would always fail at the server.
  const routed = leaves()
    .map(({ node }) => node.route?.destination)
    .filter((d): d is string => typeof d === "string");
  assert.deepEqual([...routed].sort(), [...DEST_ORDER].sort());
  for (const d of routed) {
    assert.ok(canCrossPost(d), `/${d}: routes to a platform we cannot cross-post to`);
  }
});

test("the single-letter aliases resolve to the platform, not a longer command", () => {
  // THE COLLISION GUARD. Dispatch is exact-match, so /t must not be swallowed by
  // /timer or /timeout, and /s must not be swallowed by /slowmode or /stream.
  for (const [line, want] of [
    ["/t hey", "twitch"], ["/k hey", "kick"], ["/y hey", "youtube"],
    ["/s hey", "streamplace"], ["/site hey", null],
  ] as [string, string | null][]) {
    const p = parseCommandLine(line);
    assert.ok(p.node?.route, `${line} did not resolve to a routing command`);
    assert.equal(p.node!.route!.destination, want, `${line} routed wrong`);
  }
});

test("a routing command carries the rest of the line as its message", () => {
  const p = parseCommandLine("/t hello there friend");
  assert.equal(currentArg(p)?.name, "message");
  assert.equal(argValues("/t hello there friend", p)[0], "hello there friend");
});

test("a bare routing command is missing its message", () => {
  // `/t` alone is a mistake, not an instruction — it must be refused, never
  // sent as an empty message.
  assert.equal(missingArg("/t", parseCommandLine("/t")), "message");
  assert.equal(missingArg("/t   ", parseCommandLine("/t   ")), "message");
  assert.equal(missingArg("/t hi", parseCommandLine("/t hi")), null);
});

test("routing commands are offered only for platforms the viewer has linked", () => {
  const twitchOnly = { ...VIEWER, dests: ["twitch"] };
  const offered = suggestFor(parseCommandLine("/"), twitchOnly).map((x) => x.value);
  assert.ok(offered.includes("/twitch"), "should offer the linked platform");
  assert.ok(offered.includes("/site"), "the site itself is always a destination");
  for (const hidden of ["/kick", "/youtube", "/streamplace"]) {
    assert.ok(!offered.includes(hidden), `${hidden} offered with no such account linked`);
  }
  // …and /help agrees, rather than advertising a command the palette hides.
  const h = helpText("", twitchOnly);
  assert.ok(h.includes("/twitch <message>"));
  assert.ok(!h.includes("/kick <message>"));
});

test("a viewer with no linked platforms still gets the site's own command", () => {
  const offered = suggestFor(parseCommandLine("/"), { ...VIEWER, dests: [] }).map((x) => x.value);
  assert.deepEqual(offered.sort(), [
    "/bug", "/dm", "/help", "/highlight", "/ignore", "/pronouns", "/redact", "/site", "/support", "/tts", "/unignore",
  ]);
});

test("/redact is hidden from non-Supporters and offered to Supporters", () => {
  const offered = (v: object) => suggestFor(parseCommandLine("/"), v as never).map((x) => x.value);
  assert.ok(!offered({ ...VIEWER, isSupporter: false }).includes("/redact"));
  assert.ok(offered({ ...VIEWER, isSupporter: true }).includes("/redact"));
  // `undefined` is NOT `false`: it means the subscription read has not landed
  // yet, and hiding on unknown would blink the command out on every page load.
  assert.ok(offered(VIEWER).includes("/redact"), "unknown must not read as not-a-Supporter");
  assert.ok(!helpText("", { ...VIEWER, isSupporter: false }).includes("/redact"));
});

test("/redact and /r route native-and-sealed; the old /encrypt names are gone", () => {
  for (const line of ["/e psst", "/enc psst", "/encrypt psst"]) {
    assert.equal(parseCommandLine(line).node?.route?.encrypted, undefined, `${line} still redacts — it is retired`);
  }
  for (const line of ["/redact psst", "/r psst"]) {
    const r = parseCommandLine(line).node?.route;
    assert.ok(r, `${line} did not resolve`);
    // Both halves matter: `encrypted` without a null destination would try to
    // cross-post the plaintext, which is the one thing this must never do.
    assert.equal(r!.encrypted, true, `${line} lost its seal`);
    assert.equal(r!.destination, null, `${line} is not native-only`);
  }
});

test("no routing command except /redact is sealed, and none of the sealed ones leave the site", () => {
  for (const { path, node } of leaves()) {
    if (!node.route?.encrypted) continue;
    assert.equal(node.route.destination, null,
      `/${path.join(" ")}: an encrypted message must never carry a platform destination`);
  }
});

test("/highlight and /tts are native route leaves that carry a spend", () => {
  const byName = Object.fromEntries(leaves().map(({ node }) => [node.name, node]));

  for (const [name, spend] of [["highlight", "highlight"], ["tts", "tts"]] as const) {
    const n = byName[name];
    assert.ok(n, `/${name} must exist`);
    assert.equal(n.route?.spend, spend);
    // Native by definition, exactly like /encrypt: a bought message never
    // cross-posts, so there is no platform variant of either.
    assert.equal(n.route?.destination, null);
    assert.equal(n.scope, "all");
  }
});

test("a spend command still requires its message", () => {
  assert.equal(missingArg("/tts", parseCommandLine("/tts")), "message");
  assert.equal(missingArg("/highlight", parseCommandLine("/highlight")), "message");
});

// Vacuity anchor: `spend` must be absent everywhere else, or the assertions
// above would pass on a field the spec never scoped.
test("only the two chat spends carry route.spend", () => {
  const withSpend = leaves()
    .filter(({ node }) => node.route?.spend)
    .map(({ node }) => node.name)
    .sort();
  assert.deepEqual(withSpend, ["highlight", "tts"]);
});

test("/pronouns is for everyone, and takes the values the API allowlists", () => {
  // The route allowlists exactly "he/him" | "she/her" | "they/them"; the enum
  // must not drift from it or the command 400s.
  const p = parseCommandLine("/pronouns ");
  assert.deepEqual(suggestFor(p, VIEWER).map((x) => x.value),
    ["he/him", "she/her", "they/them", "clear"]);
});

test("/dm is for everyone; /announce (and /everyone) only for mods", () => {
  const offered = (v: object) => suggestFor(parseCommandLine("/"), v as never).map((x) => x.value);
  assert.ok(offered(VIEWER).includes("/dm"));
  assert.ok(!offered(VIEWER).includes("/announce"));
  assert.ok(offered({ ...VIEWER, isMod: true }).includes("/announce"));
  assert.match(helpText("", VIEWER), /\/dm/, "the help list a viewer sees names /dm");
});

test("a mod is not offered the admin-only commands", () => {
  const names = suggestFor(parseCommandLine("/"), MOD).map((x) => x.value);
  assert.ok(!names.includes("/mod"), "/mod is admin-only");
  assert.ok(!names.includes("/unmod"), "/unmod is admin-only");
  assert.ok(names.includes("/ban"), "a mod should get /ban");
  assert.ok(suggestFor(parseCommandLine("/"), ADMIN).map((x) => x.value).includes("/mod"));
});

// ─── parsing ──────────────────────────────────────────────────────────────────

test("a bare word is not a command", () => {
  assert.equal(parseCommandLine("hello").isCommand, false);
});

test("// and a leading space are ordinary messages", () => {
  // Otherwise a doubled slash or a pasted path gets swallowed by the command path.
  assert.equal(parseCommandLine("//shrug").isCommand, false);
  assert.equal(parseCommandLine(" /ban x").isCommand, false);
});

test("resolves a nested path", () => {
  const p = parseCommandLine("/blacklist word twink 2");
  assert.deepEqual(p.pathNames, ["blacklist", "word"]);
  assert.equal(p.node?.run, "blocklistWord");
});

test("knows which argument the caret is in", () => {
  const p = parseCommandLine("/timeout alice 30m");
  assert.equal(p.completing, "arg");
  assert.equal(currentArg(p)?.name, "duration");
});

test("a rest argument keeps the caret inside it", () => {
  // "/ban alice being a jerk here" — every trailing word is still the reason.
  const p = parseCommandLine("/ban alice being a jerk here");
  assert.equal(currentArg(p)?.name, "reason");
});

test("aliases resolve", () => {
  assert.equal(parseCommandLine("/slowlist").node?.run, "slowmodeList");
});

// ─── suggestions ──────────────────────────────────────────────────────────────

test("prefix-matches sub-commands", () => {
  const p = parseCommandLine("/timer s");
  assert.deepEqual(suggestFor(p, MOD).map((s) => s.value).sort(), ["set", "start", "sub"]);
});

test("offers enum values for an enum argument", () => {
  const p = parseCommandLine("/linkgate set ");
  assert.deepEqual(suggestFor(p, MOD).map((s) => s.value), ["off", "flag", "hold"]);
});

test("completes usernames for a user argument, @ or not", () => {
  const mentions = ["alice", "alfred", "bob"];
  assert.deepEqual(suggestFor(parseCommandLine("/ban al"), MOD, mentions).map((s) => s.value),
    ["alice", "alfred"]);
  assert.deepEqual(suggestFor(parseCommandLine("/ban @al"), MOD, mentions).map((s) => s.value),
    ["alice", "alfred"], "a leading @ should complete the same way");
});

test("offers nothing for a free-text argument", () => {
  assert.deepEqual(suggestFor(parseCommandLine("/embed add the sky is"), MOD), []);
});

// ─── the bug this replaces ────────────────────────────────────────────────────

test("completing replaces ONLY the caret's token", () => {
  // THE REGRESSION GUARD. The old CommandHints called setInput(cmd + " "), so
  // picking a suggestion while "/ban someuser" was typed destroyed the argument.
  const text = "/ban al";
  const p = parseCommandLine(text);
  const out = applySuggestion(text, p, "alice");
  assert.equal(out.text, "/ban alice ");
  assert.equal(out.caret, "/ban alice ".length);
});

test("completing mid-line does not eat the rest of the line", () => {
  const text = "/timer se 30m";
  const caret = "/timer se".length;
  const p = parseCommandLine(text, caret);
  assert.equal(p.completing, "sub");
  assert.equal(applySuggestion(text, p, "set").text, "/timer set 30m");
});

test("completing an empty trailing token appends rather than replacing", () => {
  const text = "/linkgate set ";
  const p = parseCommandLine(text);
  assert.equal(applySuggestion(text, p, "flag").text, "/linkgate set flag ");
});

// ─── hint line ────────────────────────────────────────────────────────────────

test("the signature reads like the command", () => {
  assert.equal(signature(["ban"], COMMANDS.find((c) => c.name === "ban")!), "/ban <user> [reason]");
  assert.equal(hintLine(parseCommandLine("/timer set 10m")), "/timer set <time>");
  assert.equal(hintLine(parseCommandLine("/nonsense")), null);
});

// ─── coverage of the old surface ──────────────────────────────────────────────

test("everything the old dispatch table could do still exists", () => {
  // Including /addbehavior and /clearbehavior, which were dispatched but never
  // documented — the 9-listed-vs-11-dispatched drift this spec exists to end.
  const runs = new Set(leaves().map((l) => l.node.run));
  for (const r of [
    "ban", "unban", "timeout", "setmod", "unsetmod",
    "embedAdd", "embedList", "embedRemove",
  ]) {
    assert.ok(runs.has(r as never), `lost the handler for ${r}`);
  }
});

// ─── argument coercion ────────────────────────────────────────────────────────

test("durations parse the way a mod would type them", () => {
  for (const [input, want] of [
    ["30", 30], ["30m", 30], ["30 min", 30], ["45mins", 45],
    ["2h", 120], ["1 hour", 60], ["1d", 1440],
    ["90s", 2], ["30s", 1],   // sub-minute rounds UP to 1, never to 0
  ] as [string, number][]) {
    assert.equal(durationToMinutes(input), want, `failed on "${input}"`);
  }
});

test("a sub-minute timeout never becomes a zero-minute no-op", () => {
  // Rounding 20s to 0 would silently turn a timeout into nothing at all.
  assert.equal(durationToMinutes("20s"), 1);
});

test("junk durations are rejected so the caller can fall back", () => {
  for (const bad of ["", "soon", "10x", "abc", "-5"]) {
    assert.equal(durationToMinutes(bad), null, `accepted "${bad}"`);
  }
});

// ─── /help ────────────────────────────────────────────────────────────────────

test("/help shows only what the viewer may run", () => {
  const modHelp = helpText("", MOD);
  assert.ok(modHelp.includes("/ban"), "a mod should see /ban");
  assert.ok(!modHelp.includes("/mod <user>"), "a mod should not be shown admin commands");
  assert.ok(helpText("", ADMIN).includes("/mod <user>"), "an admin should see /mod");
  assert.equal(helpText("", VIEWER).includes("/ban"), false, "a viewer should not see /ban");
});

test("the pre-tree spellings are GONE, not merely hidden", () => {
  // Retired commands. They must not parse either — a command that silently
  // still works is worse than one that clearly does not.
  for (const legacy of ["/know something", "/tune chat: be terser", "/addbehavior x", "/clearbehavior"]) {
    assert.equal(parseCommandLine(legacy).node, null, `${legacy} still resolves`);
  }
  const h = helpText("", ADMIN);
  for (const legacy of ["/know ", "/tune ", "/addbehavior", "/clearbehavior"]) {
    assert.ok(!h.includes(legacy), `help still advertises ${legacy}`);
  }
});

test("/help <command> narrows to that command", () => {
  const h = helpText("timer", MOD);
  assert.ok(h.includes("/timer set"), "should list the timer sub-commands");
  assert.ok(!h.includes("/ban"), "should not list unrelated commands");
  assert.ok(helpText("nonsense", MOD).startsWith("No command matching"));
});

// ─── /support (cycle 7) ───────────────────────────────────────────────────────

test("/support parses for everyone, with the whole rest as the message", () => {
  const p = parseCommandLine("/support how do I cheer");
  assert.equal(p.node?.name, "support");
  assert.equal(p.node?.scope, "all");
  assert.deepEqual(argValues("/support how do I cheer", p), ["how do I cheer"]);
  // Bare and on/off forms all resolve to the same command — the RUNNER
  // dispatches on the first token (see run.ts), because a sub tree would eat
  // "how" in "/support how do I x" as an unknown subcommand.
  for (const line of ["/support", "/support on", "/support off"]) {
    assert.equal(parseCommandLine(line).node?.name, "support", `${line} did not resolve`);
  }
});

test("the /support runner dispatches on the first token and guards the missing panel", () => {
  // The runner can't be imported under node --test (its transitive imports are
  // extensionless), so pin the dispatch at the source like the host scans do.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run.ts"), "utf8");
  const handler = src.slice(src.indexOf("support: async"), src.indexOf("// ─── community rotation"));
  assert.ok(handler.length > 50, "the support handler is gone from run.ts");
  assert.match(handler, /if \(!support\)/, "a panel-less composer must refuse, not crash");
  assert.match(handler, /=== "off"[\s\S]{0,80}support\.close\(\)/, "off no longer closes");
  assert.match(handler, /raw === "" \|\| raw\.toLowerCase\(\) === "on"/, "bare and on no longer open");
  assert.match(handler, /support\.open\(raw\)/, "a message no longer opens with that first turn");
});

test("/bug is the fast lane: everyone-scoped, message required, no panel dependency", () => {
  // One line straight into site.support_tickets as a bug. Two
  // properties are the contract:
  //   • it must NOT go through the support panel — one line straight to the
  //     ticket table, with no panel to open, no conversation to hold, and
  //     nothing to fail in a composer that lacks the panel wiring;
  //   • the message is REQUIRED — a bare /bug filing an empty ticket would be
  //     mod-queue noise.
  const bug = leaves().find(({ node }) => node.name === "bug")?.node;
  assert.ok(bug, "/bug is gone from the command tree");
  assert.equal(bug!.scope, "all", "/bug must be offered to everyone");
  assert.equal(bug!.args?.[0]?.required, true, "the message must be required");
  const p = parseCommandLine("/bug the dock eats my scroll position");
  assert.equal(p.node?.name, "bug");
  assert.deepEqual(argValues("/bug the dock eats my scroll position", p),
    ["the dock eats my scroll position"]);

  // The handler posts kind:"bug" to the ticket route and never touches the
  // `support` panel controls (source pin — the runner closure is not
  // constructible in node --test).
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run.ts"), "utf8");
  const handler = src.slice(src.indexOf("bugReport: async"), src.indexOf("// ─── community rotation"));
  assert.ok(handler.length > 50, "could not bound the bugReport handler");
  assert.match(handler, /postJson\("\/api\/support\/ticket", \{ kind: "bug", body \}\)/,
    "the handler must file a bug ticket");
  assert.doesNotMatch(handler, /support[.!]/,
    "the handler must not depend on the support panel — /bug is the no-panel fast lane");
});
