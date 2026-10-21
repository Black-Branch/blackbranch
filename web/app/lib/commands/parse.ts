import {
  COMMANDS, leaves, moduleAvailable, nodeMatches, routeAvailable, scopeAllows, signature,
  type ArgSpec, type CommandNode,
} from "./spec.ts";

// Parsing a half-typed command line into "where is the caret, and what could go
// here" — the thing the old CommandHints could not do.
//
// The old hint list prefix-matched the FIRST WORD only, and picking a hint called
// `setInput(cmd + " ")`, replacing the entire line. So typing `/ban someuser` and
// touching a suggestion destroyed the argument. Everything here is token-scoped:
// we return the caret's token and its exact offsets, and completion rewrites only
// that span.

export type Viewer = {
  isMod: boolean;
  isAdmin: boolean;
  /**
   * Cross-post destinations the viewer has actually linked. Gates the `/twitch`
   * family — see routeAvailable, including what `undefined` means there.
   */
  dests?: string[];
  /** Active site Supporter subscription — gates `/redact`. */
  isSupporter?: boolean;
  /** Is a module / fact feature on here — gates a command's `module` (moduleAvailable). */
  features?: (id: string) => boolean;
};

/** What the caret is positioned to complete. */
export type Completing = "command" | "sub" | "arg" | "none";

export type Parsed = {
  /** Resolved node chain, e.g. [blacklist, word]. Empty if nothing matched. */
  path: CommandNode[];
  /** Names along `path`, for signature rendering. */
  pathNames: string[];
  /** Deepest resolved node, or null. */
  node: CommandNode | null;
  /** Which positional arg the caret sits in (-1 when not in one). */
  argIndex: number;
  /** The token under the caret. */
  token: string;
  tokenStart: number;
  tokenEnd: number;
  completing: Completing;
  /** True when the line is a command attempt at all (starts with a single "/"). */
  isCommand: boolean;
};

export type Suggestion = {
  /** Text inserted in place of the caret's token. */
  value: string;
  /** Primary label. */
  label: string;
  /** Right-hand description. */
  desc: string;
  /** Suggestion class, for the icon/styling. */
  kind: "command" | "sub" | "enum" | "user";
};

/** Split a line into tokens with their offsets. Runs of spaces are separators. */
function tokenize(text: string): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Parse `text` with the caret at `caret`.
 *
 * A line is only a command when it starts with exactly one "/". `//foo` and a
 * leading space are ordinary messages — otherwise a user typing a URL fragment or
 * a double slash would have their message swallowed by the command path.
 */
export function parseCommandLine(text: string, caret = text.length): Parsed {
  const empty: Parsed = {
    path: [], pathNames: [], node: null, argIndex: -1,
    token: "", tokenStart: caret, tokenEnd: caret, completing: "none", isCommand: false,
  };
  if (!text.startsWith("/") || text.startsWith("//")) return empty;

  const toks = tokenize(text);
  if (toks.length === 0) return { ...empty, isCommand: true, completing: "command" };

  // The token the caret is in or immediately after. Sitting just past a token's
  // end still counts as editing it ("/ba|" completes "ba"); a space moves on.
  let idx = toks.findIndex((t) => caret >= t.start && caret <= t.end);
  let token = "", tokenStart = caret, tokenEnd = caret;
  if (idx >= 0) {
    token = toks[idx]!.value;
    tokenStart = toks[idx]!.start;
    tokenEnd = toks[idx]!.end;
  } else {
    // Between/after tokens → completing a NEW token at the caret.
    idx = toks.filter((t) => t.end < caret).length;
  }

  // Walk the tree. Token 0 is the command name (with its leading slash stripped).
  const path: CommandNode[] = [];
  let level: CommandNode[] | undefined = COMMANDS;
  let consumed = 0;
  for (let i = 0; i < toks.length; i++) {
    const raw = i === 0 ? toks[i]!.value.slice(1) : toks[i]!.value;
    const hit: CommandNode | undefined = level?.find((n) => nodeMatches(n, raw));
    if (!hit) break;
    path.push(hit);
    consumed = i + 1;
    level = hit.sub;
    if (!level?.length) break; // reached a leaf — everything after is arguments
  }

  const node = path[path.length - 1] ?? null;
  const pathNames = path.map((n) => n.name);

  let completing: Completing = "none";
  let argIndex = -1;
  if (idx === 0) {
    completing = "command";
  } else if (node && node.sub?.length && idx === consumed) {
    completing = "sub";
  } else if (node && !node.sub?.length && idx >= consumed) {
    argIndex = idx - consumed;
    completing = argIndex < (node.args?.length ?? 0) ? "arg" : "none";
    // A `rest: true` arg swallows every remaining token, so the caret stays in it.
    const args = node.args ?? [];
    const restAt = args.findIndex((a) => a.kind === "text" && a.rest);
    if (restAt >= 0 && argIndex > restAt) { argIndex = restAt; completing = "arg"; }
  }

  return { path, pathNames, node, argIndex, token, tokenStart, tokenEnd, completing, isCommand: true };
}

/** The argument spec the caret is currently inside, if any. */
export function currentArg(p: Parsed): ArgSpec | null {
  if (p.completing !== "arg" || !p.node?.args) return null;
  return p.node.args[p.argIndex] ?? null;
}

/**
 * What could go where the caret is.
 *
 * `mentions` supplies usernames for `user` arguments — the SAME list that powers
 * `@user` autocomplete, so the two behave identically instead of being two
 * different completion experiences in one input.
 */
export function suggestFor(
  p: Parsed,
  viewer: Viewer,
  mentions: string[] = [],
): Suggestion[] {
  if (!p.isCommand) return [];
  const allowed = (n: CommandNode) =>
    !n.hidden && scopeAllows(viewer, n.scope) && routeAvailable(n, viewer) && moduleAvailable(n, viewer);

  if (p.completing === "command") {
    const typed = p.token.replace(/^\//, "").toLowerCase();
    return COMMANDS.filter(allowed)
      .filter((n) => n.name.startsWith(typed) || n.aliases?.some((a) => a.startsWith(typed)))
      .map((n) => ({ value: "/" + n.name, label: "/" + n.name, desc: n.desc, kind: "command" as const }));
  }

  if (p.completing === "sub" && p.node?.sub) {
    const typed = p.token.toLowerCase();
    return p.node.sub.filter(allowed)
      .filter((n) => n.name.startsWith(typed) || n.aliases?.some((a) => a.startsWith(typed)))
      .map((n) => ({ value: n.name, label: n.name, desc: n.desc, kind: "sub" as const }));
  }

  const arg = currentArg(p);
  if (!arg) return [];

  if (arg.kind === "enum") {
    const typed = p.token.toLowerCase();
    return arg.values
      .filter((v) => v.value.startsWith(typed))
      .map((v) => ({ value: v.value, label: v.value, desc: v.desc, kind: "enum" as const }));
  }

  if (arg.kind === "user") {
    // Accept an optional leading "@" so `/ban @ali` completes like a mention.
    const typed = p.token.replace(/^@/, "").toLowerCase();
    return mentions
      .filter((m) => m.toLowerCase().startsWith(typed))
      .slice(0, 8)
      .map((m) => ({ value: m, label: m, desc: "", kind: "user" as const }));
  }

  return [];
}

/**
 * Replace ONLY the caret's token, returning the new line and caret position.
 * A trailing space is added so the next token can be typed straight away.
 */
export function applySuggestion(
  text: string,
  p: Parsed,
  value: string,
): { text: string; caret: number } {
  const before = text.slice(0, p.tokenStart);
  const after = text.slice(p.tokenEnd);
  const insert = value + " ";
  const next = before + insert + after.replace(/^ +/, "");
  return { text: next, caret: (before + insert).length };
}

/**
 * Positional argument values for a fully-typed line.
 *
 * The `rest: true` argument swallows everything left, so `/ban alice being rude`
 * yields ["alice", "being rude"] rather than four tokens.
 */
export function argValues(text: string, p: Parsed): string[] {
  if (!p.node || p.path.length === 0) return [];
  const toks = tokenize(text);
  const after = toks.slice(p.path.length);
  const specs = p.node.args ?? [];
  const out: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (spec.kind === "text" && spec.rest) {
      out.push(after.slice(i).map((t) => t.value).join(" "));
      break;
    }
    out.push(after[i]?.value ?? "");
  }
  return out;
}

/** The first required argument that is missing, if any — for the usage message. */
export function missingArg(text: string, p: Parsed): string | null {
  if (!p.node) return null;
  const vals = argValues(text, p);
  const specs = p.node.args ?? [];
  for (let i = 0; i < specs.length; i++) {
    if (specs[i]!.required && !vals[i]?.trim()) return specs[i]!.name;
  }
  return null;
}

/** The signature line shown while typing, with the active argument marked. */
export function hintLine(p: Parsed): string | null {
  if (!p.node || p.path.length === 0) return null;
  return signature(p.pathNames, p.node);
}

// ─── argument coercion + help ────────────────────────────────────────────────
//
// These live here rather than in run.ts because run.ts imports ../http, whose own
// imports are extensionless — Node's ESM loader cannot follow that, so anything
// importing run.ts is untestable. Pure logic belongs on the testable side.

/** "30" → 30 · "45m" → 45 · "2h" → 120 · "1d" → 1440. Null when unparseable. */
export function durationToMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hour|d|day)?s?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "s": case "sec": return Math.max(1, Math.round(n / 60));
    case "h": case "hr": case "hour": return Math.round(n * 60);
    case "d": case "day": return Math.round(n * 1440);
    default: return Math.round(n); // bare number and m/min are minutes
  }
}

/** `/help` — the whole list, or one command's signature. */
export function helpText(query: string, viewer: Viewer): string {
  const q = query.trim().replace(/^\//, "").toLowerCase();
  const all = leaves().filter(({ path }) => {
    const root = COMMANDS.find((c) => c.name === path[0]);
    return root && !root.hidden && moduleAvailable(root, viewer);
  });
  const visible = all.filter(
    ({ node }) => scopeAllows(viewer, node.scope) && routeAvailable(node, viewer) && moduleAvailable(node, viewer),
  );

  if (q) {
    const hit = visible.filter(({ path }) => path.join(" ").startsWith(q));
    if (hit.length === 0) return `No command matching "${query}".`;
    return hit.map(({ path, node }) => `${signature(path, node)} — ${node.desc}`).join("\n");
  }
  if (visible.length === 0) return "No commands available to you.";
  return visible.map(({ path, node }) => `${signature(path, node)} — ${node.desc}`).join("\n");
}
